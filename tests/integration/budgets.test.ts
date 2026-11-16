// Integration test modul budgets. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider. Dilewati bila
// Postgres test tidak menyala.
//
// Fokus: normalisasi periode (monthly/weekly), satu anggaran aktif per pengguna, isolasi
// antar-pengguna, progres yang dihitung dari transaksi, upsert kategori PATCH (termasuk
// alert_sent_at), audit, soft delete, CHECK/partial unique di database, dan budget_summary
// di GET /dashboard.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import {
  budgetDetailSchema,
  budgetListSchema,
  budgetSchema,
} from '../../src/modules/budgets/budgets.schema.js';
import { dashboardResponseSchema } from '../../src/modules/dashboard/dashboard.schema.js';
import { jakartaDayStartUtc, monthBounds, todayInJakarta, weekBounds } from '../../src/shared/utils/timezone.js';
import { postJson, readJson, startServer, type JsonBody, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface TestUser {
  id: string;
  email: string;
  token: string;
}

interface Refs {
  food: string;
  transport: string;
  otherExpense: string;
  income: string;
  account: string;
}

describe.skipIf(!testDbUrl)('modul budgets (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let server: TestServer;
  let a: TestUser;
  let b: TestUser;
  let refsA: Refs;
  let refsB: Refs;

  const today = todayInJakarta();
  const current = monthBounds(today.slice(0, 7));
  const currentWeek = weekBounds(today);

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

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
    const expenses = await prisma.category.findMany({
      where: { userId: user.id, type: 'expense' },
      orderBy: { sortOrder: 'asc' },
    });
    const income = await prisma.category.findFirstOrThrow({ where: { userId: user.id, type: 'income' } });
    const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
    const [food, transport, otherExpense] = expenses;
    if (!food || !transport || !otherExpense) throw new Error('butuh tiga kategori pengeluaran');
    return {
      food: food.id,
      transport: transport.id,
      otherExpense: otherExpense.id,
      income: income.id,
      account: account.id,
    };
  }

  beforeEach(async () => {
    await resetUserData(prisma);
    await prisma.auditLog.deleteMany();
    await prisma.messageLog.deleteMany();
    await ensureSystemCategories(prisma);

    const provider = new FakeAuthProvider(prisma);
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({ authService, prisma, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
    );

    a = await register('ayu@example.com', 'Ayu Penguji');
    b = await register('budi@example.com', 'Budi Korban');
    refsA = await refsOf(a);
    refsB = await refsOf(b);
  });

  afterEach(async () => {
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(user && { authorization: `Bearer ${user.token}` }),
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  const monthlyBody = (refs: Refs = refsA, overrides: JsonBody = {}): JsonBody => ({
    name: 'Anggaran bulan ini',
    period_type: 'monthly',
    period_start: current.from,
    total_amount: 1_000_000,
    categories: [
      { category_id: refs.food, amount: 600_000 },
      { category_id: refs.transport, amount: 400_000 },
    ],
    ...overrides,
  });

  async function createVia(user: TestUser, body: JsonBody): Promise<JsonBody> {
    const res = await call('POST', '/budgets', user, body);
    expect(res.status).toBe(201);
    return readJson(res);
  }

  async function seedExpense(user: TestUser, refs: Refs, categoryId: string, amount: number, date = today) {
    return prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: refs.account,
        categoryId,
        type: 'expense',
        amount,
        occurredAt: jakartaDayStartUtc(date),
        description: 'uji anggaran',
        source: 'manual',
      },
    });
  }

  const auditOf = (entityId: string) =>
    prisma.auditLog.findMany({ where: { entityType: 'budget', entityId }, orderBy: { createdAt: 'asc' } });

  // ---- autentikasi ----

  it('menolak permintaan tanpa token', async () => {
    for (const [method, path] of [
      ['GET', '/budgets'],
      ['POST', '/budgets'],
      ['GET', '/budgets/current'],
      ['GET', `/budgets/${UNKNOWN_ID}`],
      ['PATCH', `/budgets/${UNKNOWN_ID}`],
      ['DELETE', `/budgets/${UNKNOWN_ID}`],
    ] as const) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  // ---- create ----

  it('membuat anggaran monthly: periode dinormalkan, nilai bawaan diisi, audit tercatat', async () => {
    const res = await call(
      'POST',
      '/budgets',
      a,
      monthlyBody(refsA, { name: undefined, period_start: `${today.slice(0, 7)}-15` }),
    );

    expect(res.status).toBe(201);
    const body = await readJson(res);
    budgetSchema.parse(body);

    expect(body.name).toBeNull();
    expect(body.period_type).toBe('monthly');
    expect(body.period_start).toBe(current.from);
    expect(body.period_end).toBe(current.to);
    expect(body.auto_renew).toBe(true);
    expect(body.rollover_enabled).toBe(false);
    expect(body.categories).toHaveLength(2);
    expect(body.categories[0]).toMatchObject({ alert_threshold: 80 });
    expect(body.categories[0].name).toEqual(expect.any(String));
    expect(body.categories[0].slug).toEqual(expect.any(String));

    const audits = await auditOf(body.id as string);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'create', actorType: 'user', entityType: 'budget' });
    expect(audits[0]?.changes).toMatchObject({
      after: { total_amount: 1_000_000, period_start: current.from, period_end: current.to },
    });
  });

  it('membuat anggaran weekly: Senin sampai Minggu', async () => {
    const body = await createVia(a, {
      period_type: 'weekly',
      period_start: today,
      total_amount: 500_000,
      categories: [{ category_id: refsA.food, amount: 500_000 }],
    });

    budgetSchema.parse(body);
    expect(body.period_start).toBe(currentWeek.from);
    expect(body.period_end).toBe(currentWeek.to);
  });

  it.each([
    ['total nol', { total_amount: 0 }],
    ['alokasi melebihi total', { total_amount: 500_000 }],
    ['period_type tak dikenal', { period_type: 'yearly' }],
    ['kategori kosong', { categories: [] }],
  ])('menolak body tidak valid: %s', async (_label, override) => {
    const body = monthlyBody(refsA, override as JsonBody);
    const res = await call('POST', '/budgets', a, body);
    expect(res.status).toBe(400);
    const parsed = await readJson(res);
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('menolak kategori ganda', async () => {
    const res = await call('POST', '/budgets', a, {
      period_type: 'monthly',
      period_start: current.from,
      total_amount: 100_000,
      categories: [
        { category_id: refsA.food, amount: 40_000 },
        { category_id: refsA.food, amount: 60_000 },
      ],
    });

    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('menolak kategori pemasukan dengan 400', async () => {
    const res = await call('POST', '/budgets', a, {
      period_type: 'monthly',
      period_start: current.from,
      total_amount: 100_000,
      categories: [{ category_id: refsA.income, amount: 100_000 }],
    });

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('kategori milik pengguna lain dijawab 404', async () => {
    const res = await call('POST', '/budgets', a, {
      period_type: 'monthly',
      period_start: current.from,
      total_amount: 100_000,
      categories: [{ category_id: refsB.food, amount: 100_000 }],
    });

    expect(res.status).toBe(404);
  });

  it('periode beririsan dijawab 409, termasuk monthly vs weekly', async () => {
    await createVia(a, monthlyBody());

    const sameMonth = await call('POST', '/budgets', a, monthlyBody(refsA, { period_start: current.to }));
    expect(sameMonth.status).toBe(409);
    expect((await readJson(sameMonth)).error.code).toBe('CONFLICT');

    const weekly = await call('POST', '/budgets', a, {
      period_type: 'weekly',
      period_start: today,
      total_amount: 100_000,
      categories: [{ category_id: refsA.food, amount: 100_000 }],
    });
    expect(weekly.status).toBe(409);
  });

  it('anggaran milik pengguna lain tidak menghalangi periode pengguna ini', async () => {
    await createVia(b, monthlyBody(refsB));

    await expect(createVia(a, monthlyBody())).resolves.toMatchObject({ period_start: current.from });
  });

  it('soft delete membebaskan periode untuk anggaran baru', async () => {
    const first = await createVia(a, monthlyBody());

    const deleted = await call('DELETE', `/budgets/${first.id}`, a);
    expect(deleted.status).toBe(204);

    await expect(createVia(a, monthlyBody())).resolves.toMatchObject({ period_start: current.from });
  });

  // ---- list ----

  it('daftar memuat semua status secara bawaan, urut period_start menurun', async () => {
    const previous = monthBounds(previousMonth(today));
    const past = await createVia(a, monthlyBody(refsA, { period_start: previous.from }));
    const active = await createVia(a, monthlyBody());

    const all = await call('GET', '/budgets', a);
    expect(all.status).toBe(200);
    const body = await readJson(all);
    budgetListSchema.parse(body);
    expect(body.data.map((row: JsonBody) => row.id)).toEqual([active.id, past.id]);

    const onlyActive = await call('GET', '/budgets?status=active', a);
    const filtered = await readJson(onlyActive);
    expect(filtered.data.map((row: JsonBody) => row.id)).toEqual([active.id]);
  });

  it('daftar tidak membocorkan anggaran pengguna lain dan melewati yang terhapus', async () => {
    await createVia(a, monthlyBody());
    await createVia(b, monthlyBody(refsB));

    const deleted = await createVia(a, monthlyBody(refsA, { period_start: monthBounds(previousMonth(today)).from }));
    await call('DELETE', `/budgets/${deleted.id}`, a);

    const res = await call('GET', '/budgets', a);
    const body = await readJson(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Anggaran bulan ini');
  });

  it('menolak status query yang tidak dikenal', async () => {
    const res = await call('GET', '/budgets?status=deleted', a);
    expect(res.status).toBe(400);
  });

  // ---- detail dan progres ----

  it('detail menghitung progres total dan per kategori', async () => {
    const budget = await createVia(a, monthlyBody());
    await seedExpense(a, refsA, refsA.food, 480_000);
    await seedExpense(a, refsA, refsA.otherExpense, 100_000);

    const res = await call('GET', `/budgets/${budget.id}`, a);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    budgetDetailSchema.parse(body);

    // 580.000 dari 1.000.000 = 58% -> ok.
    expect(body.spent_total).toBe(580_000);
    expect(body.remaining_total).toBe(420_000);
    expect(body.percent_total).toBe(58);
    expect(body.status_total).toBe('ok');

    const food = body.categories.find((category: JsonBody) => category.category_id === refsA.food);
    expect(food).toMatchObject({ spent: 480_000, remaining: 120_000, percent: 80, status: 'warning' });

    const transport = body.categories.find((category: JsonBody) => category.category_id === refsA.transport);
    expect(transport).toMatchObject({ spent: 0, remaining: 400_000, percent: 0, status: 'ok' });
  });

  it('pengeluaran kategori tak teralokasi masuk spent_total, tidak masuk kategori', async () => {
    const budget = await createVia(a, monthlyBody());
    await seedExpense(a, refsA, refsA.otherExpense, 100_000);

    const body = await readJson(await call('GET', `/budgets/${budget.id}`, a));

    expect(body.spent_total).toBe(100_000);
    expect(body.categories.every((category: JsonBody) => category.spent === 0)).toBe(true);
  });

  it('transaksi di luar periode, terhapus, dan milik pengguna lain tidak dihitung', async () => {
    const budget = await createVia(a, monthlyBody());
    await seedExpense(a, refsA, refsA.food, 100_000);

    const outside = new Date(`${current.from}T00:00:00.000Z`);
    outside.setUTCDate(outside.getUTCDate() - 1);
    await seedExpense(a, refsA, refsA.food, 900_000, outside.toISOString().slice(0, 10));

    const deleted = await seedExpense(a, refsA, refsA.food, 800_000);
    await prisma.transaction.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    await seedExpense(b, refsB, refsB.food, 700_000);

    const body = await readJson(await call('GET', `/budgets/${budget.id}`, a));
    expect(body.spent_total).toBe(100_000);
  });

  it('detail anggaran pengguna lain dan id tak dikenal dijawab 404', async () => {
    const budget = await createVia(a, monthlyBody());

    expect((await call('GET', `/budgets/${budget.id}`, b)).status).toBe(404);
    expect((await call('GET', `/budgets/${UNKNOWN_ID}`, a)).status).toBe(404);
  });

  it('current mengembalikan anggaran yang memuat hari ini, 404 bila tidak ada', async () => {
    const empty = await call('GET', '/budgets/current', a);
    expect(empty.status).toBe(404);

    const budget = await createVia(a, monthlyBody());
    await seedExpense(a, refsA, refsA.food, 480_000);

    const res = await call('GET', '/budgets/current', a);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    budgetDetailSchema.parse(body);
    expect(body.id).toBe(budget.id);
    expect(body.percent_total).toBe(48);
  });

  // ---- patch ----

  it('patch mengubah field dan mencatat before/after hanya untuk field yang berubah', async () => {
    const budget = await createVia(a, monthlyBody());

    const res = await call('PATCH', `/budgets/${budget.id}`, a, { name: 'Nama baru', total_amount: 1_200_000 });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    budgetSchema.parse(body);
    expect(body.name).toBe('Nama baru');
    expect(body.total_amount).toBe(1_200_000);

    const audits = await auditOf(budget.id as string);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ action: 'update' });
    expect(audits[1]?.changes).toEqual({
      before: { name: 'Anggaran bulan ini', total_amount: 1_000_000 },
      after: { name: 'Nama baru', total_amount: 1_200_000 },
    });
  });

  it('patch tanpa perubahan tidak menulis audit', async () => {
    const budget = await createVia(a, monthlyBody());

    const res = await call('PATCH', `/budgets/${budget.id}`, a, { name: 'Anggaran bulan ini' });
    expect(res.status).toBe(200);
    expect(await auditOf(budget.id as string)).toHaveLength(1);
  });

  it('patch categories melakukan upsert dan menghapus yang tidak dikirim', async () => {
    const budget = await createVia(a, monthlyBody());

    const res = await call('PATCH', `/budgets/${budget.id}`, a, {
      categories: [
        { category_id: refsA.food, amount: 700_000 },
        { category_id: refsA.otherExpense, amount: 300_000 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(
      body.categories.map((category: JsonBody) => category.category_id).sort(),
    ).toEqual([refsA.food, refsA.otherExpense].sort());
    expect(body.categories.find((category: JsonBody) => category.category_id === refsA.food)?.amount).toBe(700_000);
    expect(body.categories.find((category: JsonBody) => category.category_id === refsA.otherExpense)?.alert_threshold).toBe(80);
  });

  it('patch mempertahankan alert_threshold lama bila tidak dikirim, dan mereset alert_sent_at saat batas berubah', async () => {
    const budget = await createVia(a, monthlyBody());
    await prisma.budgetCategory.update({
      where: { budgetId_categoryId: { budgetId: budget.id as string, categoryId: refsA.food } },
      data: { alertThreshold: 90, alertSentAt: new Date() },
    });

    // Hanya nama: alokasi tidak disentuh.
    await call('PATCH', `/budgets/${budget.id}`, a, { name: 'Tetap' });
    let row = await prisma.budgetCategory.findFirstOrThrow({
      where: { budgetId: budget.id as string, categoryId: refsA.food },
    });
    expect(row.alertThreshold).toBe(90);
    expect(row.alertSentAt).not.toBeNull();

    // Amount sama, threshold tidak dikirim: nilai lama dipertahankan.
    await call('PATCH', `/budgets/${budget.id}`, a, {
      categories: [
        { category_id: refsA.food, amount: 600_000 },
        { category_id: refsA.transport, amount: 400_000 },
      ],
    });
    row = await prisma.budgetCategory.findFirstOrThrow({
      where: { budgetId: budget.id as string, categoryId: refsA.food },
    });
    expect(row.alertThreshold).toBe(90);
    expect(row.alertSentAt).not.toBeNull();

    // Amount berubah: alert_sent_at direset agar peringatan bisa terkirim lagi.
    await call('PATCH', `/budgets/${budget.id}`, a, {
      categories: [{ category_id: refsA.food, amount: 650_000 }],
    });
    row = await prisma.budgetCategory.findFirstOrThrow({
      where: { budgetId: budget.id as string, categoryId: refsA.food },
    });
    expect(row.alertSentAt).toBeNull();
  });

  it('patch menolak field periode dan body kosong', async () => {
    const budget = await createVia(a, monthlyBody());

    for (const body of [{ period_start: current.from }, { period_type: 'weekly' }, { period_end: current.to }, {}]) {
      const res = await call('PATCH', `/budgets/${budget.id}`, a, body);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('patch menolak total_amount di bawah jumlah alokasi', async () => {
    const budget = await createVia(a, monthlyBody());

    const res = await call('PATCH', `/budgets/${budget.id}`, a, { total_amount: 500_000 });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.details).toEqual([{ field: 'categories', issue: 'exceeds_total' }]);
  });

  it('patch anggaran pengguna lain dijawab 404', async () => {
    const budget = await createVia(a, monthlyBody());
    const res = await call('PATCH', `/budgets/${budget.id}`, b, { name: 'Diambil alih' });
    expect(res.status).toBe(404);
  });

  // ---- delete ----

  it('delete adalah soft delete: hilang dari daftar, audit tercatat, baris tetap ada', async () => {
    const budget = await createVia(a, monthlyBody());

    const res = await call('DELETE', `/budgets/${budget.id}`, a);
    expect(res.status).toBe(204);

    expect((await call('GET', `/budgets/${budget.id}`, a)).status).toBe(404);
    expect((await readJson(await call('GET', '/budgets', a))).data).toEqual([]);

    const row = await prisma.budget.findUniqueOrThrow({ where: { id: budget.id as string } });
    expect(row.deletedAt).not.toBeNull();

    const audits = await auditOf(budget.id as string);
    expect(audits.at(-1)).toMatchObject({ action: 'delete' });
    expect(audits.at(-1)?.changes).toMatchObject({ before: { deleted_at: null } });
  });

  it('delete anggaran pengguna lain dan id tak dikenal dijawab 404', async () => {
    const budget = await createVia(a, monthlyBody());

    expect((await call('DELETE', `/budgets/${budget.id}`, b)).status).toBe(404);
    expect((await call('DELETE', `/budgets/${UNKNOWN_ID}`, a)).status).toBe(404);
  });

  // ---- dashboard ----

  it('dashboard memuat budget_summary null bila tidak ada anggaran aktif', async () => {
    const res = await call('GET', '/dashboard', a);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    dashboardResponseSchema.parse(body);
    expect(body.budget_summary).toBeNull();
  });

  it('dashboard memuat budget_summary anggaran aktif dengan used dari pengeluaran periode', async () => {
    await createVia(a, monthlyBody());
    await seedExpense(a, refsA, refsA.food, 480_000);
    await seedExpense(a, refsA, refsA.otherExpense, 100_000);

    const res = await call('GET', '/dashboard', a);
    const body = await readJson(res);
    dashboardResponseSchema.parse(body);

    expect(body.budget_summary).toMatchObject({
      period_start: current.from,
      period_end: current.to,
      total: 1_000_000,
      used: 580_000,
      remaining: 420_000,
      percent: 58,
      status: 'ok',
    });
  });

  // ---- constraint database ----

  it('CHECK dan partial unique index menolak baris yang tidak sah', async () => {
    const base = {
      userId: a.id,
      periodType: 'monthly',
      periodStart: new Date(`${current.from}T00:00:00.000Z`),
      periodEnd: new Date(`${current.to}T00:00:00.000Z`),
      totalAmount: 100_000,
      autoRenew: true,
      rolloverEnabled: false,
    };

    await expect(
      prisma.budget.create({
        data: { ...base, totalAmount: 0, budgetCategories: { create: { categoryId: refsA.food, amount: 1_000 } } },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.budget.create({
        data: {
          ...base,
          periodEnd: new Date(`${current.from}T00:00:00.000Z`),
          periodStart: new Date(`${current.to}T00:00:00.000Z`),
          budgetCategories: { create: { categoryId: refsA.food, amount: 1_000 } },
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.budget.create({
        data: { ...base, budgetCategories: { create: { categoryId: refsA.food, amount: 0 } } },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.budget.create({
        data: {
          ...base,
          budgetCategories: { create: { categoryId: refsA.food, amount: 1_000, alertThreshold: 101 } },
        },
      }),
    ).rejects.toThrow();

    const created = await prisma.budget.create({
      data: { ...base, budgetCategories: { create: { categoryId: refsA.food, amount: 1_000 } } },
    });
    await expect(
      prisma.budget.create({
        data: { ...base, budgetCategories: { create: { categoryId: refsA.transport, amount: 1_000 } } },
      }),
    ).rejects.toThrow();

    // Baris soft-deleted tidak menghalangi periode yang sama.
    await prisma.budget.update({ where: { id: created.id }, data: { deletedAt: new Date() } });
    await expect(
      prisma.budget.create({
        data: { ...base, budgetCategories: { create: { categoryId: refsA.transport, amount: 1_000 } } },
      }),
    ).resolves.toMatchObject({ totalAmount: 100_000 });
  });
});

/** Bulan sebelumnya dalam bentuk `YYYY-MM`, dihitung dari tanggal kalender Jakarta. */
function previousMonth(today: string): string {
  const date = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}
