// Test unit service dashboard dengan dependensi palsu. Yang diuji di sini adalah perakitan:
// rumus saldo, pemilihan bulan (Jakarta), dan bentuk respons. Pengecualian baris soft-delete
// dan batas tanggal oleh SQL sebenarnya diuji di tests/integration/dashboard.test.ts; fake
// ledger di bawah hanya meniru kontraknya.

import { describe, expect, it, vi } from 'vitest';
import { buildDemoDataset, DEMO_INITIAL_BALANCE } from '../../prisma/seed-demo-data.js';
import { dashboardResponseSchema } from '../../src/modules/dashboard/dashboard.schema.js';
import { createDashboardService, RECENT_TRANSACTIONS_LIMIT } from '../../src/modules/dashboard/dashboard.service.js';
import type {
  DashboardSummary,
  DashboardTransactions,
  DashboardUsers,
} from '../../src/modules/dashboard/dashboard.types.js';
import type { DailyCashflow, DateRange, PeriodTotals } from '../../src/modules/transactions/transactions.summary.js';

const USER_ID = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const EMAIL = 'dey@example.com';

interface LedgerRow {
  date: string;
  type: 'income' | 'expense';
  amount: number;
  deleted?: boolean;
}

/** Meniru summary asli: baris soft-delete dikecualikan, rentang `from`/`to` inklusif. */
function fakeSummary(ledger: LedgerRow[]): DashboardSummary & {
  sumByType: ReturnType<typeof vi.fn>;
  dailyCashflow: ReturnType<typeof vi.fn>;
} {
  const inRange = (row: LedgerRow, { from, to }: DateRange = {}): boolean =>
    !row.deleted && (!from || row.date >= from) && (!to || row.date <= to);

  return {
    sumByType: vi.fn(async (_userId: string, range?: DateRange): Promise<PeriodTotals> => {
      const totals: PeriodTotals = { income: 0, expense: 0 };
      for (const row of ledger) if (inRange(row, range)) totals[row.type] += row.amount;
      return totals;
    }),
    dailyCashflow: vi.fn(async (_userId: string, range: Required<DateRange>): Promise<DailyCashflow[]> => {
      const byDate = new Map<string, DailyCashflow>();
      for (const row of ledger) {
        if (!inRange(row, range)) continue;
        const entry = byDate.get(row.date) ?? { date: row.date, income: 0, expense: 0 };
        entry[row.type] += row.amount;
        byDate.set(row.date, entry);
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    }),
  };
}

const fakeUsers = (initialBalance: number): DashboardUsers & { getMe: ReturnType<typeof vi.fn> } => ({
  getMe: vi.fn(async (userId: string, email: string) => ({
    id: userId,
    email,
    full_name: 'Dey',
    avatar_url: null,
    initial_balance: initialBalance,
    currency: 'IDR',
    timezone: 'Asia/Jakarta',
    locale: 'id-ID',
    onboarding_completed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
  })),
});

const fakeTransactions = (): DashboardTransactions & { list: ReturnType<typeof vi.fn> } => ({
  list: vi.fn(async () => ({ data: [], next_cursor: null, has_more: false })),
});

function build(initialBalance: number, ledger: LedgerRow[], now = new Date('2026-09-15T05:00:00Z')) {
  const users = fakeUsers(initialBalance);
  const transactions = fakeTransactions();
  const summary = fakeSummary(ledger);
  const service = createDashboardService({ users, transactions, summary, now: () => now });
  return { service, users, transactions, summary };
}

describe('saldo', () => {
  it('pengguna baru tanpa transaksi: saldo 0, bulan semua 0, tanpa arus kas dan transaksi', async () => {
    const { service } = build(0, []);

    const body = await service.get(USER_ID, EMAIL, {});

    expect(body).toEqual({
      balance: 0,
      month: { income: 0, expense: 0, net: 0 },
      cashflow: [],
      recent_transactions: [],
    });
  });

  it('hanya saldo awal: saldo sama dengan saldo awal', async () => {
    const { service } = build(2_350_000, []);

    const body = await service.get(USER_ID, EMAIL, {});

    expect(body.balance).toBe(2_350_000);
    expect(body.month).toEqual({ income: 0, expense: 0, net: 0 });
  });

  it('campuran pemasukan dan pengeluaran: saldo awal + pemasukan - pengeluaran, baris soft-delete tidak ikut', async () => {
    const { service } = build(1_000_000, [
      { date: '2026-09-01', type: 'income', amount: 5_000_000 },
      { date: '2026-09-02', type: 'expense', amount: 125_000 },
      { date: '2026-09-03', type: 'expense', amount: 87_000 },
      // Sudah di-soft-delete: tidak boleh mengubah saldo.
      { date: '2026-09-04', type: 'expense', amount: 900_000, deleted: true },
      { date: '2026-09-05', type: 'income', amount: 3_000_000, deleted: true },
    ]);

    const body = await service.get(USER_ID, EMAIL, { month: '2026-09' });

    expect(body.balance).toBe(1_000_000 + 5_000_000 - 125_000 - 87_000);
    expect(body.month).toEqual({ income: 5_000_000, expense: 212_000, net: 4_788_000 });
    expect(body.cashflow).toEqual([
      { date: '2026-09-01', income: 5_000_000, expense: 0 },
      { date: '2026-09-02', income: 0, expense: 125_000 },
      { date: '2026-09-03', income: 0, expense: 87_000 },
    ]);
  });

  it('saldo dan net bisa negatif', async () => {
    const { service } = build(100_000, [{ date: '2026-09-02', type: 'expense', amount: 450_000 }]);

    const body = await service.get(USER_ID, EMAIL, { month: '2026-09' });

    expect(body.balance).toBe(-350_000);
    expect(body.month.net).toBe(-450_000);
  });

  it('saldo seluruh waktu, tidak bergantung bulan yang diminta; angka bulan bergantung', async () => {
    const ledger: LedgerRow[] = [
      { date: '2026-08-10', type: 'income', amount: 7_000_000 },
      { date: '2026-08-20', type: 'expense', amount: 1_000_000 },
      { date: '2026-09-10', type: 'expense', amount: 400_000 },
    ];
    const { service } = build(500_000, ledger);

    const august = await service.get(USER_ID, EMAIL, { month: '2026-08' });
    const september = await service.get(USER_ID, EMAIL, { month: '2026-09' });
    const empty = await service.get(USER_ID, EMAIL, { month: '2020-01' });

    for (const body of [august, september, empty]) expect(body.balance).toBe(500_000 + 7_000_000 - 1_000_000 - 400_000);
    expect(august.month).toEqual({ income: 7_000_000, expense: 1_000_000, net: 6_000_000 });
    expect(september.month).toEqual({ income: 0, expense: 400_000, net: -400_000 });
    expect(empty.month).toEqual({ income: 0, expense: 0, net: 0 });
    expect(empty.cashflow).toEqual([]);
  });

  it('saldo dihitung ulang tiap panggilan: tidak ada nilai yang disimpan', async () => {
    const ledger: LedgerRow[] = [{ date: '2026-09-01', type: 'income', amount: 1_000_000 }];
    const { service } = build(0, ledger);

    expect((await service.get(USER_ID, EMAIL, {})).balance).toBe(1_000_000);
    ledger.push({ date: '2026-09-02', type: 'expense', amount: 250_000 });
    expect((await service.get(USER_ID, EMAIL, {})).balance).toBe(750_000);
    ledger[1] = { ...(ledger[1] as LedgerRow), deleted: true };
    expect((await service.get(USER_ID, EMAIL, {})).balance).toBe(1_000_000);
  });
});

describe('periode (Asia/Jakarta)', () => {
  it('bulan bawaan mengikuti Jakarta: 30 Sep 17:30 UTC sudah 1 Okt WIB', async () => {
    const { service, summary } = build(0, [], new Date('2026-09-30T17:30:00Z'));
    await service.get(USER_ID, EMAIL, {});
    expect(summary.sumByType).toHaveBeenCalledWith(USER_ID, { from: '2026-10-01', to: '2026-10-31' });
  });

  it('bulan bawaan: 30 Sep 16:30 UTC masih 30 Sep WIB', async () => {
    const { service, summary } = build(0, [], new Date('2026-09-30T16:30:00Z'));
    await service.get(USER_ID, EMAIL, {});
    expect(summary.sumByType).toHaveBeenCalledWith(USER_ID, { from: '2026-09-01', to: '2026-09-30' });
  });

  it('parameter month menentukan rentang, termasuk Februari kabisat', async () => {
    const { service, summary } = build(0, []);
    await service.get(USER_ID, EMAIL, { month: '2028-02' });
    expect(summary.sumByType).toHaveBeenCalledWith(USER_ID, { from: '2028-02-01', to: '2028-02-29' });
    expect(summary.dailyCashflow).toHaveBeenCalledWith(USER_ID, { from: '2028-02-01', to: '2028-02-29' });
  });

  it('saldo memakai kueri tanpa rentang (seluruh waktu)', async () => {
    const { service, summary } = build(0, []);
    await service.get(USER_ID, EMAIL, { month: '2026-09' });
    expect(summary.sumByType).toHaveBeenCalledWith(USER_ID);
  });
});

describe('kontrak dan identitas', () => {
  it('hasil lolos skema respons dan tidak memuat budget_summary', async () => {
    const { service } = build(2_000_000, [{ date: '2026-09-02', type: 'expense', amount: 25_000 }]);
    const body = await service.get(USER_ID, EMAIL, { month: '2026-09' });

    dashboardResponseSchema.parse(body);
    expect(Object.keys(body).sort()).toEqual(['balance', 'cashflow', 'month', 'recent_transactions']);
  });

  it('meminta transaksi terbaru sebanyak batasnya dan meneruskan datanya apa adanya', async () => {
    const { service, transactions } = build(0, []);
    const row = { id: 'x' };
    transactions.list.mockResolvedValueOnce({ data: [row], next_cursor: 'abc', has_more: true });

    const body = await service.get(USER_ID, EMAIL, {});

    expect(transactions.list).toHaveBeenCalledWith(USER_ID, { limit: RECENT_TRANSACTIONS_LIMIT });
    expect(RECENT_TRANSACTIONS_LIMIT).toBe(5);
    expect(body.recent_transactions).toEqual([row]);
  });

  it('semua dependensi dipanggil dengan id pengguna dari pemanggil', async () => {
    const { service, users, summary, transactions } = build(0, []);
    await service.get(USER_ID, EMAIL, {});
    expect(users.getMe).toHaveBeenCalledWith(USER_ID, EMAIL);
    for (const call of summary.sumByType.mock.calls) expect(call[0]).toBe(USER_ID);
    for (const call of summary.dailyCashflow.mock.calls) expect(call[0]).toBe(USER_ID);
    expect(transactions.list.mock.calls[0]?.[0]).toBe(USER_ID);
  });

  it('kegagalan service lain (mis. profil tidak ada) merambat apa adanya', async () => {
    const { service, users } = build(0, []);
    users.getMe.mockRejectedValueOnce(new Error('Profil tidak ditemukan'));
    await expect(service.get(USER_ID, EMAIL, {})).rejects.toThrow('Profil tidak ditemukan');
  });
});

describe('data seed P8', () => {
  const today = '2026-10-03';
  const now = new Date('2026-10-03T05:00:00Z');
  const { transactions: demo } = buildDemoDataset(today);
  const ledger: LedgerRow[] = demo.map((t) => ({
    date: t.date,
    type: t.type,
    amount: t.amount,
    deleted: t.deletedAt !== null,
  }));
  const live = ledger.filter((row) => !row.deleted);
  const sum = (rows: LedgerRow[], type: 'income' | 'expense') =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0);

  it('saldo = saldo awal + pemasukan - pengeluaran aktif; baris terhapus (Rp4,5 juta salah ketik dll.) tidak ikut', async () => {
    const { service } = build(DEMO_INITIAL_BALANCE, ledger, now);
    const body = await service.get(USER_ID, EMAIL, { month: '2026-09' });

    expect(body.balance).toBe(DEMO_INITIAL_BALANCE + sum(live, 'income') - sum(live, 'expense'));
    expect(body.balance).not.toBe(
      DEMO_INITIAL_BALANCE + sum(ledger, 'income') - sum(ledger, 'expense'), // andai baris terhapus ikut
    );
  });

  it.each(['2026-08', '2026-09', '2026-10'])('angka bulan %s dan arus kas cocok dengan dataset', async (month) => {
    const { service } = build(DEMO_INITIAL_BALANCE, ledger, now);
    const body = await service.get(USER_ID, EMAIL, { month });
    const monthRows = live.filter((r) => r.date.startsWith(month));

    expect(body.month.income).toBe(sum(monthRows, 'income'));
    expect(body.month.expense).toBe(sum(monthRows, 'expense'));
    expect(body.month.net).toBe(sum(monthRows, 'income') - sum(monthRows, 'expense'));
    expect(body.cashflow.map((d) => d.date)).toEqual([...new Set(monthRows.map((r) => r.date))].sort());
    expect(body.cashflow.reduce((s, d) => s + d.expense, 0)).toBe(sum(monthRows, 'expense'));
    expect(body.cashflow.reduce((s, d) => s + d.income, 0)).toBe(sum(monthRows, 'income'));
  });

  it('bulan penuh: pemasukan melebihi pengeluaran, saldo positif', async () => {
    const { service } = build(DEMO_INITIAL_BALANCE, ledger, now);
    const body = await service.get(USER_ID, EMAIL, { month: '2026-09' });
    expect(body.month.net).toBeGreaterThan(0);
    expect(body.balance).toBeGreaterThan(DEMO_INITIAL_BALANCE);
  });
});
