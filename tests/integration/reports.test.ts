// Integration test modul reports. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider. Dilewati bila
// Postgres test tidak menyala.
//
// Fokus: batas bulan Asia/Jakarta (termasuk 23:59 vs 00:00 WIB), baris soft-delete,
// kategori soft-deleted, isolasi antar-pengguna, pengisian hari kosong, dan kecocokan
// angka bulanan dengan GET /dashboard.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildDemoDataset, DEMO_EMAIL, DEMO_PASSWORD, demoMonths } from '../../prisma/seed-demo-data.js';
import { seedDemo } from '../../prisma/seed-demo.js';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { dashboardResponseSchema } from '../../src/modules/dashboard/dashboard.schema.js';
import { monthlyReportSchema, trendReportSchema } from '../../src/modules/reports/reports.schema.js';
import {
  currentMonthInJakarta,
  jakartaDayStartUtc,
  lastMonths,
  todayInJakarta,
} from '../../src/shared/utils/timezone.js';
import { postJson, readJson, startServer, type JsonBody, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

interface TestUser {
  id: string;
  email: string;
  token: string;
}

interface CategoryRef {
  id: string;
  name: string;
  slug: string;
}

interface Refs {
  /** Minimal dua kategori pengeluaran, urut sort_order. */
  expenses: [CategoryRef, CategoryRef];
  income: CategoryRef;
  account: string;
}

describe.skipIf(!testDbUrl)('modul reports (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;
  let server: TestServer;

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

  async function register(email: string, fullName: string): Promise<TestUser> {
    const res = await postJson(`${server.url}/auth/register`, {
      email,
      password: 'rahasia-banget-123',
      full_name: fullName,
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.user.id, email, token: body.session.access_token };
  }

  async function refsOf(user: TestUser): Promise<Refs> {
    const categories = await prisma.category.findMany({
      where: { userId: user.id },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, slug: true, type: true },
    });
    const expenses = categories.filter((category) => category.type === 'expense');
    const income = categories.find((category) => category.type === 'income');
    const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id }, select: { id: true } });
    if (expenses.length < 2 || !income) throw new Error('kategori sistem tidak lengkap');
    return {
      expenses: [expenses[0]!, expenses[1]!],
      income,
      account: account.id,
    };
  }

  const call = (path: string, user?: Pick<TestUser, 'token'>) =>
    fetch(`${server.url}${path}`, {
      headers: { ...(user && { authorization: `Bearer ${user.token}` }) },
    });

  async function monthly(user: Pick<TestUser, 'token'>, month?: string): Promise<JsonBody> {
    const res = await call(`/reports/monthly${month ? `?month=${month}` : ''}`, user);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    monthlyReportSchema.parse(body);
    return body;
  }

  async function trend(user: Pick<TestUser, 'token'>, months?: number): Promise<JsonBody> {
    const res = await call(`/reports/trend${months !== undefined ? `?months=${months}` : ''}`, user);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    trendReportSchema.parse(body);
    return body;
  }

  async function dashboard(user: Pick<TestUser, 'token'>, month: string): Promise<JsonBody> {
    const res = await call(`/dashboard?month=${month}`, user);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    dashboardResponseSchema.parse(body);
    return body;
  }

  /** Langsung ke DB supaya instan UTC presisi dan tanggal lama tidak ditolak validasi API. */
  async function insert(
    user: TestUser,
    refs: Refs,
    row: {
      type: 'income' | 'expense';
      amount: number;
      occurredAt: Date;
      categoryId?: string;
      deleted?: boolean;
    },
  ) {
    return prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: refs.account,
        categoryId: row.categoryId ?? (row.type === 'income' ? refs.income.id : refs.expenses[0].id),
        type: row.type,
        amount: row.amount,
        occurredAt: row.occurredAt,
        source: 'manual',
        ...(row.deleted && { deletedAt: new Date() }),
      },
    });
  }

  const sumDaily = (body: JsonBody, field: 'income' | 'expense') =>
    (body.daily as { income: number; expense: number }[]).reduce((total, day) => total + day[field], 0);

  // ---- autentikasi dan validasi ----

  describe('autentikasi dan validasi', () => {
    it('401 tanpa token dan dengan token ngawur', async () => {
      for (const path of ['/reports/monthly', '/reports/trend']) {
        const missing = await call(path);
        expect(missing.status).toBe(401);
        expect((await readJson(missing)).error.code).toBe('UNAUTHORIZED');
        expect((await call(path, { token: 'ngawur' })).status).toBe(401);
      }
    });

    it.each(['September-2026', '2026-13', '2026-00', '2026-9', '202609', ''])(
      '400 untuk month "%s"',
      async (month) => {
        const user = await register('ayu@example.com', 'Ayu');
        const res = await call(`/reports/monthly?month=${encodeURIComponent(month)}`, user);
        expect(res.status).toBe(400);
        expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      },
    );

    it.each(['0', '13', '1.5', 'abc', ''])('400 untuk months "%s"', async (months) => {
      const user = await register('budi@example.com', 'Budi');
      const res = await call(`/reports/trend?months=${encodeURIComponent(months)}`, user);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---- laporan bulanan ----

  describe('GET /reports/monthly', () => {
    it('total, kategori, persen per tipe, hari kosong, dan pengecualian soft-delete', async () => {
      const user = await register('citra@example.com', 'Citra');
      const other = await register('dedi@example.com', 'Dedi');
      const refs = await refsOf(user);
      const otherRefs = await refsOf(other);

      await insert(user, refs, { type: 'income', amount: 5_000_000, occurredAt: jakartaDayStartUtc('2026-10-01') });
      await insert(user, refs, {
        type: 'expense',
        amount: 200_000,
        occurredAt: jakartaDayStartUtc('2026-10-02'),
        categoryId: refs.expenses[0].id,
      });
      await insert(user, refs, {
        type: 'expense',
        amount: 400_000,
        occurredAt: jakartaDayStartUtc('2026-10-03'),
        categoryId: refs.expenses[1].id,
      });
      await insert(user, refs, {
        type: 'expense',
        amount: 999_999,
        occurredAt: jakartaDayStartUtc('2026-10-04'),
        deleted: true,
      });
      await insert(other, otherRefs, { type: 'expense', amount: 777_777, occurredAt: jakartaDayStartUtc('2026-10-05') });

      const body = await monthly(user, '2026-10');

      expect(body.month).toBe('2026-10');
      expect(body.income_total).toBe(5_000_000);
      expect(body.expense_total).toBe(600_000);
      expect(body.net).toBe(4_400_000);
      expect(body.by_category.map((item: JsonBody) => item.category_id)).toEqual([
        refs.income.id,
        refs.expenses[1].id,
        refs.expenses[0].id,
      ]);
      expect(body.by_category.map((item: JsonBody) => item.percent)).toEqual([100, 66.7, 33.3]);
      expect(body.by_category[0]).toMatchObject({ name: refs.income.name, slug: refs.income.slug, type: 'income' });

      expect(body.daily).toHaveLength(31);
      expect(body.daily[0]).toEqual({ date: '2026-10-01', income: 5_000_000, expense: 0 });
      expect(body.daily[1]).toEqual({ date: '2026-10-02', income: 0, expense: 200_000 });
      expect(body.daily[2]).toEqual({ date: '2026-10-03', income: 0, expense: 400_000 });
      expect(body.daily[3]).toEqual({ date: '2026-10-04', income: 0, expense: 0 });
      expect(sumDaily(body, 'income')).toBe(body.income_total);
      expect(sumDaily(body, 'expense')).toBe(body.expense_total);
    });

    it('23:59 WIB masuk bulan berjalan; 00:00 WIB masuk bulan berikutnya', async () => {
      const user = await register('eka@example.com', 'Eka');
      const refs = await refsOf(user);

      await insert(user, refs, {
        type: 'expense',
        amount: 10_000,
        occurredAt: new Date('2026-10-31T16:59:00Z'), // 2026-10-31 23:59 WIB
      });
      await insert(user, refs, {
        type: 'expense',
        amount: 20_000,
        occurredAt: new Date('2026-10-31T17:00:00Z'), // 2026-11-01 00:00 WIB
      });

      const october = await monthly(user, '2026-10');
      const november = await monthly(user, '2026-11');

      expect(october.expense_total).toBe(10_000);
      expect(october.daily.at(-1)).toEqual({ date: '2026-10-31', income: 0, expense: 10_000 });
      expect(november.expense_total).toBe(20_000);
      expect(november.daily[0]).toEqual({ date: '2026-11-01', income: 0, expense: 20_000 });
    });

    it('bulan masa depan dan bulan kosong menghasilkan nol dengan hari lengkap', async () => {
      const user = await register('fajar@example.com', 'Fajar');

      const future = await monthly(user, '2999-01');

      expect(future).toMatchObject({
        month: '2999-01',
        income_total: 0,
        expense_total: 0,
        net: 0,
        by_category: [],
      });
      expect(future.daily).toHaveLength(31);
      expect(future.daily.every((day: JsonBody) => day.income === 0 && day.expense === 0)).toBe(true);
    });

    it('kategori yang sudah soft-deleted tetap tampil karena transaksi lama merujuknya', async () => {
      const user = await register('gita@example.com', 'Gita');
      const refs = await refsOf(user);

      await insert(user, refs, {
        type: 'expense',
        amount: 50_000,
        occurredAt: jakartaDayStartUtc('2026-10-05'),
        categoryId: refs.expenses[0].id,
      });
      await prisma.category.update({ where: { id: refs.expenses[0].id }, data: { deletedAt: new Date() } });

      const body = await monthly(user, '2026-10');
      expect(body.by_category).toEqual([
        expect.objectContaining({
          category_id: refs.expenses[0].id,
          name: refs.expenses[0].name,
          slug: refs.expenses[0].slug,
          total: 50_000,
        }),
      ]);
    });

    it('tanpa parameter memakai bulan berjalan Asia/Jakarta', async () => {
      const user = await register('hadi@example.com', 'Hadi');
      const body = await monthly(user);
      expect(body.month).toBe(currentMonthInJakarta());
    });
  });

  // ---- tren ----

  describe('GET /reports/trend', () => {
    it('urut menaik, bulan kosong tetap nol, dan data pengguna lain tidak bocor', async () => {
      const user = await register('indah@example.com', 'Indah');
      const other = await register('joko@example.com', 'Joko');
      const refs = await refsOf(user);
      const otherRefs = await refsOf(other);
      const [first, second, third] = lastMonths(currentMonthInJakarta(), 3);

      await insert(user, refs, { type: 'income', amount: 1_000, occurredAt: jakartaDayStartUtc(`${first}-01`) });
      await insert(user, refs, { type: 'expense', amount: 500, occurredAt: jakartaDayStartUtc(`${third}-01`) });
      await insert(user, refs, {
        type: 'expense',
        amount: 9_999,
        occurredAt: jakartaDayStartUtc(`${second}-01`),
        deleted: true,
      });
      await insert(other, otherRefs, {
        type: 'income',
        amount: 8_888,
        occurredAt: jakartaDayStartUtc(`${second}-01`),
      });

      const body = await trend(user, 3);

      expect(body.months).toEqual([
        { month: first, income: 1_000, expense: 0, net: 1_000 },
        { month: second, income: 0, expense: 0, net: 0 },
        { month: third, income: 0, expense: 500, net: -500 },
      ]);
    });

    it('bawaan 6 bulan dan months=1 hanya bulan berjalan', async () => {
      const user = await register('kiki@example.com', 'Kiki');
      const current = currentMonthInJakarta();

      const six = await trend(user);
      expect(six.months).toHaveLength(6);
      expect(six.months.at(-1)?.month).toBe(current);
      expect(six.months.map((item: JsonBody) => item.month)).toEqual(lastMonths(current, 6));

      const one = await trend(user, 1);
      expect(one.months).toEqual([{ month: current, income: 0, expense: 0, net: 0 }]);
    });
  });

  // ---- verifikasi silang dengan dashboard ----

  describe('verifikasi silang dengan data seed demo', () => {
    it('total bulanan reports sama dengan GET /dashboard untuk bulan yang sama', async () => {
      await seedDemo(prisma, provider, { email: DEMO_EMAIL, password: DEMO_PASSWORD, reset: false });
      const { session } = await provider.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
      const demo = { token: session.access_token };
      const today = todayInJakarta();
      const dataset = buildDemoDataset(today).transactions.filter((row) => !row.deletedAt);
      const sum = (type: 'income' | 'expense', month: string) =>
        dataset
          .filter((row) => row.type === type && row.date.startsWith(month))
          .reduce((total, row) => total + row.amount, 0);

      for (const month of demoMonths(today)) {
        const report = await monthly(demo, month);
        const home = await dashboard(demo, month);

        expect(report.income_total).toBe(home.month.income);
        expect(report.expense_total).toBe(home.month.expense);
        expect(report.net).toBe(home.month.net);
        expect(report.income_total).toBe(sum('income', month));
        expect(report.expense_total).toBe(sum('expense', month));
        expect(sumDaily(report, 'income')).toBe(report.income_total);
        expect(sumDaily(report, 'expense')).toBe(report.expense_total);
      }
    });
  });
});
