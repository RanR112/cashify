// Integration test modul dashboard. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider. Dilewati bila
// Postgres test tidak menyala. Kontrak: claude/API.md bagian 5.
//
// Fokus: saldo SELALU dihitung (saldo awal + pemasukan - pengeluaran, tanpa baris
// soft-delete), batas bulan menurut Asia/Jakarta, dan isolasi antar-pengguna.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildDemoDataset, DEMO_EMAIL, DEMO_INITIAL_BALANCE, DEMO_PASSWORD, demoMonths } from '../../prisma/seed-demo-data.js';
import { seedDemo } from '../../prisma/seed-demo.js';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { dashboardResponseSchema } from '../../src/modules/dashboard/dashboard.schema.js';
import { RECENT_TRANSACTIONS_LIMIT } from '../../src/modules/dashboard/dashboard.service.js';
import { transactionSchema } from '../../src/modules/transactions/transactions.schema.js';
import { currentMonthInJakarta, jakartaDayStartUtc, todayInJakarta } from '../../src/shared/utils/timezone.js';
import { postJson, readJson, startServer, type JsonBody, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

interface TestUser {
  id: string;
  email: string;
  token: string;
}

interface Refs {
  expense: string;
  income: string;
  account: string;
}

describe.skipIf(!testDbUrl)('modul dashboard (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;
  let server: TestServer;
  const today = todayInJakarta();
  const thisMonth = currentMonthInJakarta();

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetUserData(prisma);
    await prisma.auditLog.deleteMany();
    await prisma.messageLog.deleteMany();
    await ensureSystemCategories(prisma);
    provider = new FakeAuthProvider(prisma);
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({ authService, prisma, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
    );
  });

  afterEach(async () => {
    await server.close();
  });

  // ---- alat bantu ----

  async function register(email: string, fullName: string, initialBalance?: number): Promise<TestUser> {
    const res = await postJson(`${server.url}/auth/register`, {
      email,
      password: 'rahasia-banget-123',
      full_name: fullName,
      ...(initialBalance !== undefined && { initial_balance: initialBalance }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.user.id, email, token: body.session.access_token };
  }

  async function refsOf(user: TestUser): Promise<Refs> {
    const [expense, income, account] = await Promise.all([
      prisma.category.findFirstOrThrow({ where: { userId: user.id, type: 'expense' }, orderBy: { sortOrder: 'asc' } }),
      prisma.category.findFirstOrThrow({ where: { userId: user.id, type: 'income' }, orderBy: { sortOrder: 'asc' } }),
      prisma.account.findFirstOrThrow({ where: { userId: user.id } }),
    ]);
    return { expense: expense.id, income: income.id, account: account.id };
  }

  const call = (method: string, path: string, user?: Pick<TestUser, 'token'>, body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(user && { authorization: `Bearer ${user.token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  async function dashboard(user: Pick<TestUser, 'token'>, month?: string): Promise<JsonBody> {
    const res = await call('GET', `/dashboard${month ? `?month=${month}` : ''}`, user);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    dashboardResponseSchema.parse(body);
    return body;
  }

  /** Lewat API, supaya sama dengan yang dilakukan klien (validasi tanggal berlaku). */
  async function createVia(user: TestUser, refs: Refs, type: 'income' | 'expense', amount: number, date = today) {
    const res = await call('POST', '/transactions', user, {
      type,
      amount,
      category_id: type === 'income' ? refs.income : refs.expense,
      account_id: refs.account,
      date,
    });
    expect(res.status).toBe(201);
    return (await readJson(res)) as JsonBody;
  }

  /** Langsung ke DB: untuk tanggal yang ditolak validasi API dan instan UTC yang presisi. */
  async function insert(
    user: TestUser,
    refs: Refs,
    row: { type: 'income' | 'expense'; amount: number; occurredAt: Date; deleted?: boolean; description?: string },
  ) {
    return prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: refs.account,
        categoryId: row.type === 'income' ? refs.income : refs.expense,
        type: row.type,
        amount: row.amount,
        occurredAt: row.occurredAt,
        description: row.description ?? null,
        source: 'manual',
        ...(row.deleted && { deletedAt: new Date() }),
      },
    });
  }

  const dayStart = (date: string) => jakartaDayStartUtc(date);

  // ---- autentikasi dan validasi ----

  describe('autentikasi dan validasi', () => {
    it('401 tanpa token dan dengan token ngawur', async () => {
      const missing = await call('GET', '/dashboard');
      expect(missing.status).toBe(401);
      expect((await readJson(missing)).error.code).toBe('UNAUTHORIZED');
      expect((await call('GET', '/dashboard', { token: 'ngawur' })).status).toBe(401);
    });

    it.each(['September-2026', '2026-13', '2026-00', '2026-9', '202609', ''])('400 untuk month "%s"', async (month) => {
      const user = await register('ayu@example.com', 'Ayu');
      const res = await call('GET', `/dashboard?month=${encodeURIComponent(month)}`, user);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---- saldo ----

  describe('saldo', () => {
    it('pengguna baru tanpa transaksi: semuanya 0 dan kosong', async () => {
      const user = await register('ayu@example.com', 'Ayu');

      const body = await dashboard(user);

      expect(body).toEqual({
        balance: 0,
        month: { income: 0, expense: 0, net: 0 },
        cashflow: [],
        recent_transactions: [],
      });
      expect(Object.keys(body)).not.toContain('budget_summary');
    });

    it('hanya saldo awal: balance = initial_balance', async () => {
      const user = await register('ayu@example.com', 'Ayu', 2_350_000);

      const body = await dashboard(user);

      expect(body.balance).toBe(2_350_000);
      expect(body.month).toEqual({ income: 0, expense: 0, net: 0 });
    });

    it('saldo awal diubah lewat PATCH /me: saldo ikut berubah (dihitung, bukan disimpan)', async () => {
      const user = await register('ayu@example.com', 'Ayu', 2_350_000);
      const refs = await refsOf(user);
      await createVia(user, refs, 'income', 1_000_000);

      expect((await dashboard(user)).balance).toBe(3_350_000);

      const patch = await call('PATCH', '/me', user, { initial_balance: 500_000 });
      expect(patch.status).toBe(200);
      expect((await dashboard(user)).balance).toBe(1_500_000);
    });

    it('campuran pemasukan dan pengeluaran: saldo awal + pemasukan - pengeluaran', async () => {
      const user = await register('ayu@example.com', 'Ayu', 1_000_000);
      const refs = await refsOf(user);
      await createVia(user, refs, 'income', 5_000_000);
      await createVia(user, refs, 'expense', 125_000);
      await createVia(user, refs, 'expense', 87_000);

      const body = await dashboard(user);

      expect(body.balance).toBe(1_000_000 + 5_000_000 - 125_000 - 87_000);
      expect(body.month).toEqual({ income: 5_000_000, expense: 212_000, net: 4_788_000 });
      expect(body.cashflow).toEqual([{ date: today, income: 5_000_000, expense: 212_000 }]);
    });

    it('transaksi yang di-soft-delete tidak ikut; restore mengembalikannya', async () => {
      const user = await register('ayu@example.com', 'Ayu', 1_000_000);
      const refs = await refsOf(user);
      await createVia(user, refs, 'income', 5_000_000);
      const big = await createVia(user, refs, 'expense', 900_000);
      await createVia(user, refs, 'expense', 100_000);
      // Sudah terhapus sejak awal (baris yang tidak pernah boleh terhitung).
      await insert(user, refs, { type: 'income', amount: 3_000_000, occurredAt: dayStart(today), deleted: true });

      expect((await dashboard(user)).balance).toBe(1_000_000 + 5_000_000 - 900_000 - 100_000);

      expect((await call('DELETE', `/transactions/${big.id}`, user)).status).toBe(204);
      const afterDelete = await dashboard(user);
      expect(afterDelete.balance).toBe(1_000_000 + 5_000_000 - 100_000);
      expect(afterDelete.month).toEqual({ income: 5_000_000, expense: 100_000, net: 4_900_000 });
      expect(afterDelete.cashflow).toEqual([{ date: today, income: 5_000_000, expense: 100_000 }]);

      expect((await call('POST', `/transactions/${big.id}/restore`, user)).status).toBe(200);
      expect((await dashboard(user)).balance).toBe(1_000_000 + 5_000_000 - 900_000 - 100_000);
    });

    it('saldo bisa negatif', async () => {
      const user = await register('ayu@example.com', 'Ayu', 100_000);
      const refs = await refsOf(user);
      await createVia(user, refs, 'expense', 450_000);

      const body = await dashboard(user);

      expect(body.balance).toBe(-350_000);
      expect(body.month.net).toBe(-450_000);
    });

    it('saldo seluruh waktu; angka bulan hanya untuk bulan yang diminta', async () => {
      const user = await register('ayu@example.com', 'Ayu', 500_000);
      const refs = await refsOf(user);
      await insert(user, refs, { type: 'income', amount: 7_000_000, occurredAt: dayStart('2026-08-10') });
      await insert(user, refs, { type: 'expense', amount: 1_000_000, occurredAt: dayStart('2026-08-20') });
      await insert(user, refs, { type: 'expense', amount: 400_000, occurredAt: dayStart('2026-09-10') });
      const expectedBalance = 500_000 + 7_000_000 - 1_000_000 - 400_000;

      const august = await dashboard(user, '2026-08');
      const september = await dashboard(user, '2026-09');
      const empty = await dashboard(user, '2020-01');

      for (const body of [august, september, empty]) expect(body.balance).toBe(expectedBalance);
      expect(august.month).toEqual({ income: 7_000_000, expense: 1_000_000, net: 6_000_000 });
      expect(september.month).toEqual({ income: 0, expense: 400_000, net: -400_000 });
      expect(empty.month).toEqual({ income: 0, expense: 0, net: 0 });
      expect(august.cashflow).toEqual([
        { date: '2026-08-10', income: 7_000_000, expense: 0 },
        { date: '2026-08-20', income: 0, expense: 1_000_000 },
      ]);
      expect(empty.cashflow).toEqual([]);
    });

    it('tanpa month: memakai bulan berjalan menurut Jakarta', async () => {
      const user = await register('ayu@example.com', 'Ayu');
      const refs = await refsOf(user);
      await createVia(user, refs, 'expense', 25_000);

      expect(await dashboard(user)).toEqual(await dashboard(user, thisMonth));
      expect((await dashboard(user)).month.expense).toBe(25_000);
    });
  });

  // ---- zona waktu ----

  describe('batas bulan Asia/Jakarta', () => {
    it('30 Sep 23:30 WIB masuk September; 1 Okt 00:30 WIB masuk Oktober', async () => {
      const user = await register('ayu@example.com', 'Ayu');
      const refs = await refsOf(user);
      // 23:30 WIB = 16:30 UTC (masih 30 Sep di UTC); 00:30 WIB = 17:30 UTC (30 Sep di UTC, 1 Okt di Jakarta).
      await insert(user, refs, { type: 'expense', amount: 11_000, occurredAt: new Date('2026-09-30T16:30:00Z') });
      await insert(user, refs, { type: 'expense', amount: 22_000, occurredAt: new Date('2026-09-30T17:30:00Z') });

      const september = await dashboard(user, '2026-09');
      const october = await dashboard(user, '2026-10');

      expect(september.month.expense).toBe(11_000);
      expect(september.cashflow).toEqual([{ date: '2026-09-30', income: 0, expense: 11_000 }]);
      expect(october.month.expense).toBe(22_000);
      expect(october.cashflow).toEqual([{ date: '2026-10-01', income: 0, expense: 22_000 }]);
      expect(september.balance).toBe(33_000 * -1);
      expect(october.balance).toBe(september.balance);
    });

    it('hari pertama dan terakhir bulan masuk bulannya (Februari kabisat)', async () => {
      const user = await register('ayu@example.com', 'Ayu');
      const refs = await refsOf(user);
      for (const date of ['2028-01-31', '2028-02-01', '2028-02-29', '2028-03-01']) {
        await insert(user, refs, { type: 'expense', amount: 1_000, occurredAt: dayStart(date) });
      }

      const february = await dashboard(user, '2028-02');

      expect(february.cashflow.map((d: { date: string }) => d.date)).toEqual(['2028-02-01', '2028-02-29']);
      expect(february.month.expense).toBe(2_000);
    });
  });

  // ---- transaksi terbaru ----

  describe('recent_transactions', () => {
    it(`paling banyak ${RECENT_TRANSACTIONS_LIMIT}, terbaru dulu, tanpa baris soft-delete, dengan kategori dan akun`, async () => {
      const user = await register('ayu@example.com', 'Ayu');
      const refs = await refsOf(user);
      const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'];
      for (const [index, date] of dates.entries()) {
        await insert(user, refs, { type: 'expense', amount: 1_000 * (index + 1), occurredAt: dayStart(date) });
      }
      // Tanggal terbaru tetapi terhapus: tidak boleh muncul.
      await insert(user, refs, { type: 'expense', amount: 999_999, occurredAt: dayStart('2026-09-20'), deleted: true });

      const body = await dashboard(user, '2026-09');

      expect(body.recent_transactions).toHaveLength(RECENT_TRANSACTIONS_LIMIT);
      expect(body.recent_transactions.map((t: { date: string }) => t.date)).toEqual(dates.slice(2).reverse());
      for (const row of body.recent_transactions) {
        transactionSchema.parse(row);
        expect(row.category.name).toEqual(expect.any(String));
        expect(row.account.name).toBe('Tunai');
      }
      expect(JSON.stringify(body.recent_transactions)).not.toContain('999999');
    });

    it('tidak bergantung pada bulan yang dipilih', async () => {
      const user = await register('ayu@example.com', 'Ayu');
      const refs = await refsOf(user);
      await insert(user, refs, { type: 'expense', amount: 5_000, occurredAt: dayStart('2026-09-10') });

      const body = await dashboard(user, '2020-01');

      expect(body.month.expense).toBe(0);
      expect(body.recent_transactions).toHaveLength(1);
    });
  });

  // ---- isolasi ----

  describe('isolasi antar-pengguna', () => {
    it('saldo, bulan, arus kas, dan transaksi terbaru pengguna lain tidak bocor', async () => {
      const a = await register('ayu@example.com', 'Ayu', 1_000_000);
      const b = await register('budi@example.com', 'Budi Korban', 9_000_000);
      const refsA = await refsOf(a);
      const refsB = await refsOf(b);
      await createVia(a, refsA, 'income', 2_000_000);
      await insert(b, refsB, { type: 'income', amount: 50_000_000, occurredAt: dayStart(today), description: 'RAHASIA-BUDI' });
      await insert(b, refsB, { type: 'expense', amount: 7_777_000, occurredAt: dayStart(today) });

      const res = await call('GET', '/dashboard', a);
      const text = JSON.stringify(await readJson(res));
      const body = JSON.parse(text) as JsonBody;

      expect(body.balance).toBe(3_000_000);
      expect(body.month).toEqual({ income: 2_000_000, expense: 0, net: 2_000_000 });
      expect(body.recent_transactions).toHaveLength(1);
      expect(text).not.toContain('RAHASIA-BUDI');
      expect(text).not.toContain('7777000');

      const bBody = await dashboard(b);
      expect(bBody.balance).toBe(9_000_000 + 50_000_000 - 7_777_000);
    });
  });

  // ---- data seed P8 ----

  describe('data seed P8 (pengguna demo)', () => {
    it('angka bulanan, arus kas, dan saldo cocok dengan dataset; baris soft-delete tidak ikut', async () => {
      await seedDemo(prisma, provider, { email: DEMO_EMAIL, password: DEMO_PASSWORD, reset: false });
      const { session } = await provider.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
      const demo = { token: session.access_token };

      const dataset = buildDemoDataset(today).transactions;
      const live = dataset.filter((t) => !t.deletedAt);
      expect(dataset.length).toBeGreaterThan(live.length); // ada baris terhapus yang harus diabaikan
      const sum = (rows: typeof live, type: 'income' | 'expense') =>
        rows.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);

      for (const month of demoMonths(today)) {
        const rows = live.filter((t) => t.date.startsWith(month));
        const body = await dashboard(demo, month);

        expect(body.balance).toBe(DEMO_INITIAL_BALANCE + sum(live, 'income') - sum(live, 'expense'));
        expect(body.month).toEqual({
          income: sum(rows, 'income'),
          expense: sum(rows, 'expense'),
          net: sum(rows, 'income') - sum(rows, 'expense'),
        });
        expect(body.cashflow.map((d: { date: string }) => d.date)).toEqual([...new Set(rows.map((t) => t.date))].sort());
        expect(body.recent_transactions).toHaveLength(RECENT_TRANSACTIONS_LIMIT);
      }

      // Bulan berjalan dari tanpa parameter sama dengan bulan terakhir dataset.
      expect(await dashboard(demo)).toEqual(await dashboard(demo, demoMonths(today)[2]));
    });
  });
});
