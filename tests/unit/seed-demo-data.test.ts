import { describe, expect, it } from 'vitest';
import { SYSTEM_CATEGORIES } from '../../prisma/seed-data.js';
import {
  buildDemoBudget,
  buildDemoDataset,
  buildDemoNotifications,
  DEMO_ACCOUNTS,
  DEMO_SALARY_AMOUNT,
  DEMO_SALARY_DAY,
  demoMonths,
  demoWindowStart,
  formatAmountForChat,
  type DemoCategorySpend,
  type DemoTransactionSpec,
} from '../../prisma/seed-demo-data.js';
import { addDays, isValidDateString, jakartaDayStartUtc } from '../../src/shared/utils/timezone.js';

// Awal bulan, akhir bulan, pergantian tahun, dan 1 Maret (jendela melewati Februari kabisat).
const TODAYS = ['2026-10-03', '2026-10-31', '2026-01-15', '2026-03-01', '2028-03-01', '2026-02-28'];

const live = (transactions: DemoTransactionSpec[]) => transactions.filter((t) => !t.deletedAt);
const expensesOf = (transactions: DemoTransactionSpec[]) => live(transactions).filter((t) => t.type === 'expense');

function sumByMonth(transactions: DemoTransactionSpec[], type: 'income' | 'expense'): Map<string, number> {
  const totals = new Map<string, number>();
  for (const t of live(transactions)) {
    if (t.type !== type) continue;
    const month = t.date.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + t.amount);
  }
  return totals;
}

describe('jendela tanggal demo', () => {
  it('dimulai tanggal 1 dua bulan sebelum bulan ini, termasuk lintas tahun', () => {
    expect(demoWindowStart('2026-10-03')).toBe('2026-08-01');
    expect(demoWindowStart('2026-03-01')).toBe('2026-01-01');
    expect(demoWindowStart('2026-02-28')).toBe('2025-12-01');
    expect(demoWindowStart('2026-01-15')).toBe('2025-11-01');
  });

  it('demoMonths memberi tiga bulan berurutan', () => {
    expect(demoMonths('2026-10-03')).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(demoMonths('2026-02-28')).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});

describe('formatAmountForChat', () => {
  it('menulis nominal dalam tiga gaya', () => {
    expect(formatAmountForChat(25_000, 'ribu')).toBe('25 ribu');
    expect(formatAmountForChat(25_000, 'rb')).toBe('25rb');
    expect(formatAmountForChat(18_000, 'k')).toBe('18k');
  });

  it('menolak nominal yang bukan kelipatan Rp1.000', () => {
    expect(() => formatAmountForChat(25_500, 'rb')).toThrow(RangeError);
  });
});

describe('buildDemoDataset', () => {
  it('menolak tanggal yang tidak sah', () => {
    expect(() => buildDemoDataset('2026-02-30')).toThrow(RangeError);
  });

  it('deterministik untuk tanggal yang sama', () => {
    expect(buildDemoDataset('2026-10-03')).toEqual(buildDemoDataset('2026-10-03'));
  });

  describe.each(TODAYS)('untuk hari ini = %s', (today) => {
    const { startDate, endDate, transactions } = buildDemoDataset(today);

    it('seluruh tanggal sah, di dalam jendela, dan tidak di masa depan', () => {
      expect(endDate).toBe(today);
      for (const t of transactions) {
        expect(isValidDateString(t.date), t.date).toBe(true);
        expect(t.date >= startDate && t.date <= today, t.date).toBe(true);
      }
    });

    it('nominal bilangan bulat rupiah, positif, dan wajar', () => {
      for (const t of transactions) {
        expect(Number.isInteger(t.amount), `${t.description} ${t.amount}`).toBe(true);
        expect(t.amount).toBeGreaterThan(0);
        expect(t.amount).toBeLessThan(1_000_000_000);
      }
    });

    it('gaji tepat sekali per bulan, di tanggal yang sama, ke BCA', () => {
      const salaries = transactions.filter((t) => t.categorySlug === 'salary');
      expect(salaries).toHaveLength(3);
      for (const salary of salaries) {
        expect(salary.date.slice(8, 10)).toBe(String(DEMO_SALARY_DAY).padStart(2, '0'));
        expect(salary.amount).toBe(DEMO_SALARY_AMOUNT);
        expect(salary.type).toBe('income');
        expect(salary.account).toBe('BCA');
      }
      expect(new Set(salaries.map((s) => s.date.slice(0, 7))).size).toBe(3);
    });

    it('makanan Rp15.000-Rp75.000 dan hampir setiap hari', () => {
      const food = live(transactions).filter((t) => t.categorySlug === 'food');
      for (const t of food) {
        expect(t.amount, t.description).toBeGreaterThanOrEqual(15_000);
        expect(t.amount, t.description).toBeLessThanOrEqual(75_000);
      }
      const days = new Set(food.map((t) => t.date));
      let totalDays = 0;
      for (let date = startDate; date <= today; date = addDays(date, 1)) totalDays += 1;
      expect(days.size / totalDays).toBeGreaterThanOrEqual(0.85);
    });

    it('transportasi beberapa kali seminggu', () => {
      const rides = live(transactions).filter((t) => t.categorySlug === 'transport');
      let totalDays = 0;
      for (let date = startDate; date <= today; date = addDays(date, 1)) totalDays += 1;
      const perWeek = (rides.length / totalDays) * 7;
      expect(perWeek).toBeGreaterThanOrEqual(2);
      expect(perWeek).toBeLessThanOrEqual(6);
    });

    it('listrik dan internet muncul tiap bulan yang sudah lewat tanggalnya', () => {
      const bills = live(transactions).filter((t) => t.categorySlug === 'bills');
      const internet = bills.filter((t) => t.description === 'Internet bulanan');
      expect(internet.every((t) => t.amount === 349_000 && t.date.endsWith('-10'))).toBe(true);
      const [m0, m1] = demoMonths(today);
      for (const month of [m0, m1]) {
        expect(bills.some((t) => t.date.startsWith(month) && t.description === 'Tagihan listrik')).toBe(true);
        expect(internet.some((t) => t.date.startsWith(month))).toBe(true);
      }
    });

    it('pengeluaran bulan penuh wajar terhadap gaji dan tidak melonjak antar-bulan', () => {
      const expenses = sumByMonth(transactions, 'expense');
      const [m0, m1] = demoMonths(today);
      const full = [expenses.get(m0) ?? 0, expenses.get(m1) ?? 0];
      for (const total of full) {
        expect(total).toBeGreaterThan(3_000_000);
        expect(total).toBeLessThan(DEMO_SALARY_AMOUNT * 0.85);
      }
      expect(Math.max(...full) / Math.min(...full)).toBeLessThan(1.4);
    });

    it('pemasukan bulan penuh melebihi pengeluarannya (tabungan positif)', () => {
      const income = sumByMonth(transactions, 'income');
      const expenses = sumByMonth(transactions, 'expense');
      for (const month of demoMonths(today)) {
        expect(income.get(month) ?? 0, month).toBeGreaterThan(expenses.get(month) ?? 0);
      }
    });

    it('pengeluaran harian bervariasi dan tidak ada transaksi aktif yang ganjil besar', () => {
      const perDay = new Map<string, number>();
      for (const t of expensesOf(transactions)) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amount);
      const values = [...perDay.values()];
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      expect(Math.sqrt(variance) / mean).toBeGreaterThan(0.4); // tidak datar
      for (const t of expensesOf(transactions)) expect(t.amount, t.description).toBeLessThanOrEqual(1_000_000);
    });

    it('kategori dan dompet semuanya dikenal, dan tipe cocok dengan kategorinya', () => {
      const bySlug = new Map(SYSTEM_CATEGORIES.map((c) => [c.slug, c]));
      const accounts: string[] = DEMO_ACCOUNTS.map((a) => a.name);
      for (const t of transactions) {
        expect(bySlug.get(t.categorySlug)?.type, t.categorySlug).toBe(t.type);
        expect(accounts).toContain(t.account);
      }
    });

    it('kedua dompet dipakai', () => {
      expect(new Set(transactions.map((t) => t.account))).toEqual(new Set(['Tunai', 'BCA']));
    });

    it('transaksi WhatsApp: pesan memuat nominalnya, nomor urut berurutan, bukan hari ini', () => {
      const wa = transactions.filter((t) => t.source === 'whatsapp');
      expect(wa.length).toBeGreaterThanOrEqual(8);
      expect(wa.map((t) => t.whatsappSeq)).toEqual(wa.map((_, i) => i + 1));
      for (const t of wa) {
        expect(t.whatsappBody).not.toBeNull();
        expect(t.date < today, 'pesan hari ini bisa lebih lambat dari jam seed').toBe(true);
        const digits = String(t.amount / 1000);
        expect(t.whatsappBody, t.description).toMatch(new RegExp(`\\b${digits}(?: ribu|rb|k)\\b`));
      }
      for (const t of transactions.filter((x) => x.source === 'manual')) {
        expect(t.whatsappBody).toBeNull();
        expect(t.whatsappSeq).toBeNull();
      }
    });

    it('4-6 transaksi soft-delete; waktunya setelah transaksi dan tidak di masa depan', () => {
      const deleted = transactions.filter((t) => t.deletedAt);
      expect(deleted.length).toBeGreaterThanOrEqual(4);
      expect(deleted.length).toBeLessThanOrEqual(6);
      const endOfToday = jakartaDayStartUtc(addDays(today, 1)).getTime();
      for (const t of deleted) {
        const at = (t.deletedAt as Date).getTime();
        expect(at).toBeGreaterThan(jakartaDayStartUtc(t.date).getTime() + t.minuteOfDay * 60_000);
        expect(at).toBeLessThan(endOfToday);
      }
      // Cukup salah satunya berasal dari WhatsApp, supaya jalur hapus-lewat-bot terlihat.
      expect(deleted.some((t) => t.source === 'whatsapp')).toBe(true);
    });

    it('jam pesan WhatsApp jatuh di hari yang sama menurut Jakarta', () => {
      for (const t of transactions.filter((x) => x.source === 'whatsapp')) {
        expect(t.minuteOfDay).toBeGreaterThanOrEqual(0);
        expect(t.minuteOfDay).toBeLessThan(24 * 60);
      }
    });
  });
});

describe('anggaran demo', () => {
  const today = '2026-10-03';
  const currentMonth: DemoCategorySpend[] = [
    { categoryId: 'food', name: 'Makanan', slug: 'food', total: 900_000 },
    { categoryId: 'transport', name: 'Transportasi', slug: 'transport', total: 300_000 },
  ];
  const recent: DemoCategorySpend[] = [
    ...currentMonth,
    { categoryId: 'bills', name: 'Tagihan', slug: 'bills', total: 800_000 },
    { categoryId: 'shopping', name: 'Belanja', slug: 'shopping', total: 600_000 },
  ];

  it('3-4 kategori, periode bulan berjalan, dan tepat satu kategori warning', () => {
    const budget = buildDemoBudget(today, { currentMonth, recent });
    expect(budget).not.toBeNull();
    if (!budget) return;

    expect(budget.periodStart).toBe('2026-10-01');
    expect(budget.periodEnd).toBe('2026-10-31');
    expect(budget.name).toBe('Anggaran Oktober 2026');
    expect(budget.categories.length).toBeGreaterThanOrEqual(3);
    expect(budget.categories.length).toBeLessThanOrEqual(4);
    expect(budget.totalAmount).toBeGreaterThanOrEqual(
      budget.categories.reduce((sum, category) => sum + category.amount, 0),
    );
    expect(budget.alertCategoryId).toBe('food');
    expect(budget.alertSpent).toBe(900_000);

    const percents = budget.categories.map((category) => {
      const spent = category.categoryId === 'food' ? 900_000 : category.categoryId === 'transport' ? 300_000 : 0;
      return (spent / category.amount) * 100;
    });
    const warnings = percents.filter((percent) => percent >= 80 && percent <= 100);
    expect(warnings).toHaveLength(1);
    expect(percents.filter((percent) => percent > 100)).toHaveLength(0);
    expect(budget.categories.every((category) => category.alertThreshold === 80)).toBe(true);
  });

  it('tanpa pengeluaran bulan berjalan: kategori dari 60 hari terakhir, tanpa warning', () => {
    const budget = buildDemoBudget(today, { currentMonth: [], recent });
    expect(budget).not.toBeNull();
    if (!budget) return;

    expect(budget.alertCategoryId).toBeNull();
    expect(budget.alertSpent).toBe(0);
    expect(budget.categories.length).toBe(4);
    expect(budget.categories.every((category) => category.amount === 100_000)).toBe(true);
  });

  it('tanpa kategori sama sekali menghasilkan null', () => {
    expect(buildDemoBudget(today, { currentMonth: [], recent: [] })).toBeNull();
  });

  it('deterministik untuk tanggal dan data yang sama', () => {
    expect(buildDemoBudget(today, { currentMonth, recent })).toEqual(
      buildDemoBudget(today, { currentMonth, recent }),
    );
  });
});

describe('notifikasi demo', () => {
  const today = '2026-10-03';
  const currentMonth: DemoCategorySpend[] = [
    { categoryId: 'food', name: 'Makanan', slug: 'food', total: 900_000 },
  ];
  const recent: DemoCategorySpend[] = [
    ...currentMonth,
    { categoryId: 'transport', name: 'Transportasi', slug: 'transport', total: 300_000 },
    { categoryId: 'bills', name: 'Tagihan', slug: 'bills', total: 800_000 },
  ];
  const budget = buildDemoBudget(today, { currentMonth, recent });
  const dailyStats = [
    {
      date: '2026-10-02',
      income: 0,
      expense: 75_000,
      topExpenseCategory: { name: 'Makanan', total: 50_000 },
    },
    {
      date: '2026-10-01',
      income: DEMO_SALARY_AMOUNT,
      expense: 120_000,
      topExpenseCategory: null,
    },
  ];

  it('menghasilkan sent, failed, dan read dengan tanggal lampau', () => {
    const specs = buildDemoNotifications(today, { dailyStats, budget, budgetId: 'budget-1' });
    expect(specs.map((spec) => spec.status)).toEqual(expect.arrayContaining(['sent', 'failed', 'read']));
    expect(specs).toHaveLength(3);

    const sent = specs.find((spec) => spec.status === 'sent');
    const failed = specs.find((spec) => spec.status === 'failed');
    const read = specs.find((spec) => spec.status === 'read');

    expect(sent?.payload).toEqual({ date: '2026-10-02' });
    expect(sent?.sentAt).not.toBeNull();
    expect(sent?.body).toContain('Ringkasan 2 Okt');
    expect(failed?.payload).toEqual({ date: '2026-10-01' });
    expect(failed?.sentAt).toBeNull();
    expect(failed?.body).toContain('Ringkasan 1 Okt');
    expect(read?.payload).toEqual({ budget_id: 'budget-1', category_id: 'food' });
    expect(read?.body).toContain('Anggaran Makanan');
    expect(read?.sentAt).not.toBeNull();
    expect(read?.scheduledFor).toBeNull();

    for (const spec of specs) {
      expect(spec.createdAt.getTime()).toBeLessThan(jakartaDayStartUtc(today).getTime());
      expect(spec.body.length).toBeLessThan(600);
      expect(spec.title.length).toBeGreaterThan(0);
    }
  });

  it('mengabaikan tanggal hari ini dan masa depan', () => {
    const specs = buildDemoNotifications(today, {
      dailyStats: [
        { date: today, income: 1000, expense: 0, topExpenseCategory: null },
        ...dailyStats,
      ],
      budget,
      budgetId: 'budget-1',
    });
    expect(specs.filter((spec) => spec.type === 'daily_summary').map((spec) => spec.payload)).toEqual([
      { date: '2026-10-02' },
      { date: '2026-10-01' },
    ]);
  });

  it('tanpa anggaran warning tidak membuat baris budget_alert', () => {
    const specs = buildDemoNotifications(today, { dailyStats, budget: null, budgetId: null });
    expect(specs.map((spec) => spec.type)).toEqual(['daily_summary', 'daily_summary']);
  });

  it('deterministik untuk tanggal dan data yang sama', () => {
    expect(buildDemoNotifications(today, { dailyStats, budget, budgetId: 'budget-1' })).toEqual(
      buildDemoNotifications(today, { dailyStats, budget, budgetId: 'budget-1' }),
    );
  });
});
