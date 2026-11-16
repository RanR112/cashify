// Aturan bisnis service budgets dengan repository dan SpendingReader palsu, tanpa database.
// Perilaku SQL (partial unique, audit, reset alert_sent_at) diuji di tests/integration/budgets.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createBudgetsService } from '../../src/modules/budgets/budgets.service.js';
import type {
  BudgetRecord,
  BudgetsRepository,
  CreateOutcome,
  SpendingSnapshot,
  UpdateOutcome,
} from '../../src/modules/budgets/budgets.types.js';
import { AppError } from '../../src/shared/errors/AppError.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const BUDGET_ID = '11111111-1111-4111-8111-111111111111';
const FOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSPORT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SALARY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_EXPENSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AUDIT = { ipAddress: null };
const NOW = new Date('2026-10-15T05:00:00Z'); // 2026-10-15 12:00 WIB

function record(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    userId: USER,
    id: BUDGET_ID,
    name: 'Anggaran Oktober',
    periodType: 'monthly',
    periodStart: new Date('2026-10-01T00:00:00.000Z'),
    periodEnd: new Date('2026-10-31T00:00:00.000Z'),
    totalAmount: 3_000_000,
    autoRenew: true,
    rolloverEnabled: false,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    budgetCategories: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        categoryId: FOOD,
        amount: 1_000_000,
        alertThreshold: 80,
        alertSentAt: null,
        category: { name: 'Makanan', slug: 'food' },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        categoryId: TRANSPORT,
        amount: 2_000_000,
        alertThreshold: 100,
        alertSentAt: null,
        category: { name: 'Transportasi', slug: 'transport' },
      },
    ],
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<BudgetsRepository> = {}): BudgetsRepository {
  const types: Record<string, string> = {
    [FOOD]: 'expense',
    [TRANSPORT]: 'expense',
    [OTHER_EXPENSE]: 'expense',
    [SALARY]: 'income',
  };
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => record()),
    findActive: vi.fn(async () => record()),
    findOverlapping: vi.fn(async () => null),
    findVisibleCategories: vi.fn(async (_userId: string, ids: string[]) =>
      ids
        .filter((id) => types[id])
        .map((id) => ({ id, name: id === FOOD ? 'Makanan' : 'Lainnya', slug: id === FOOD ? 'food' : 'other', type: types[id]! })),
    ),
    create: vi.fn(async (): Promise<CreateOutcome> => ({ status: 'created', record: record() })),
    update: vi.fn(async (): Promise<UpdateOutcome> => ({ status: 'updated', record: record() })),
    softDelete: vi.fn(async () => true),
    listDueRenewals: vi.fn(async () => []),
    createRenewal: vi.fn(async (): Promise<CreateOutcome> => ({ status: 'created', record: record() })),
    ...overrides,
  };
}

const fakeSpending = (snapshot: SpendingSnapshot = { total: 0, byCategory: {} }) => ({
  spendingInRange: vi.fn(async () => snapshot),
});

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

const createInput = (overrides = {}) => ({
  name: 'Anggaran Oktober',
  period_type: 'monthly' as const,
  period_start: '2026-10-15',
  total_amount: 3_000_000,
  auto_renew: true,
  rollover_enabled: false,
  categories: [{ category_id: FOOD, amount: 1_000_000, alert_threshold: 80 }],
  ...overrides,
});

describe('create', () => {
  it('menormalkan monthly ke tanggal 1 dan menghitung akhir bulan', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.create(USER, createInput(), AUDIT);

    expect(repository.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        periodType: 'monthly',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        totalAmount: 3_000_000,
      }),
      AUDIT,
    );
  });

  it('menormalkan weekly ke Senin dan menghitung Minggu', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.create(USER, createInput({ period_type: 'weekly', period_start: '2026-10-07' }), AUDIT);

    expect(repository.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ periodType: 'weekly', periodStart: '2026-10-05', periodEnd: '2026-10-11' }),
      AUDIT,
    );
  });

  it('nama yang tidak dikirim disimpan sebagai null', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.create(USER, createInput({ name: undefined }), AUDIT);

    expect(repository.create).toHaveBeenCalledWith(USER, expect.objectContaining({ name: null }), AUDIT);
  });

  it('menolak periode yang beririsan dengan 409', async () => {
    const repository = fakeRepository({ findOverlapping: vi.fn(async () => ({ id: BUDGET_ID })) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.create(USER, createInput(), AUDIT));

    expect(error.code).toBe('CONFLICT');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('menerjemahkan pelanggaran unique index menjadi 409', async () => {
    const repository = fakeRepository({ create: vi.fn(async () => ({ status: 'conflict' as const })) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.create(USER, createInput(), AUDIT));

    expect(error.code).toBe('CONFLICT');
  });

  it('kategori tidak terlihat dijawab 404', async () => {
    const repository = fakeRepository({ findVisibleCategories: vi.fn(async () => []) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.create(USER, createInput(), AUDIT));

    expect(error.code).toBe('NOT_FOUND');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('kategori pemasukan dijawab 400 type_mismatch', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(
      service.create(USER, createInput({ categories: [{ category_id: SALARY, amount: 1_000, alert_threshold: 80 }] }), AUDIT),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'category_id', issue: 'type_mismatch' }]);
  });
});

describe('progres', () => {
  const serviceWith = (spent: SpendingSnapshot) =>
    createBudgetsService({ repository: fakeRepository(), spending: fakeSpending(spent), now: () => NOW });

  it('menghitung total dan per kategori; pengeluaran kategori lain hanya masuk total', async () => {
    const service = serviceWith({ total: 2_650_000, byCategory: { [FOOD]: 800_000, [SALARY]: 1_850_000 } });

    const body = await service.get(USER, BUDGET_ID);

    expect(body.spent_total).toBe(2_650_000);
    expect(body.remaining_total).toBe(350_000);
    expect(body.percent_total).toBe(88.3);
    expect(body.status_total).toBe('warning');

    const food = body.categories.find((category) => category.category_id === FOOD);
    expect(food).toMatchObject({ spent: 800_000, remaining: 200_000, percent: 80, status: 'warning' });

    const transport = body.categories.find((category) => category.category_id === TRANSPORT);
    expect(transport).toMatchObject({ spent: 0, remaining: 2_000_000, percent: 0, status: 'ok' });
  });

  it.each([
    ['tepat 80%', 800_000, 80, 'warning'],
    ['tepat 100%', 1_000_000, 100, 'warning'],
    ['di atas 100%', 1_100_000, 110, 'over'],
    ['belum mencapai ambang', 700_000, 70, 'ok'],
  ])('%s', (_label, spent, percent, status) => {
    const service = serviceWith({ total: spent, byCategory: { [FOOD]: spent } });
    return service.get(USER, BUDGET_ID).then((body) => {
      const food = body.categories.find((category) => category.category_id === FOOD);
      expect(food?.percent).toBe(percent);
      expect(food?.status).toBe(status);
    });
  });

  it('pemakaian nol: persen 0, bukan NaN', async () => {
    const body = await serviceWith({ total: 0, byCategory: {} }).get(USER, BUDGET_ID);

    expect(body.percent_total).toBe(0);
    expect(body.status_total).toBe('ok');
    expect(body.remaining_total).toBe(3_000_000);
    for (const category of body.categories) expect(category.percent).toBe(0);
  });

  it('remaining bisa negatif saat pemakaian melebihi anggaran', async () => {
    const body = await serviceWith({ total: 3_500_000, byCategory: { [FOOD]: 3_500_000 } }).get(USER, BUDGET_ID);

    expect(body.remaining_total).toBe(-500_000);
    expect(body.categories.find((category) => category.category_id === FOOD)?.remaining).toBe(-2_500_000);
  });

  it('membaca pengeluaran pada rentang periode anggaran', async () => {
    const spending = fakeSpending();
    const service = createBudgetsService({ repository: fakeRepository(), spending, now: () => NOW });

    await service.get(USER, BUDGET_ID);

    expect(spending.spendingInRange).toHaveBeenCalledWith(USER, { from: '2026-10-01', to: '2026-10-31' });
  });
});

describe('update', () => {
  it('menolak total_amount yang lebih kecil dari jumlah alokasi yang ada', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.update(USER, BUDGET_ID, { total_amount: 500_000 }, AUDIT));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'categories', issue: 'exceeds_total' }]);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('mempertahankan alert_threshold lama bila tidak dikirim', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.update(USER, BUDGET_ID, { categories: [{ category_id: FOOD, amount: 900_000 }] }, AUDIT);

    expect(repository.update).toHaveBeenCalledWith(
      USER,
      BUDGET_ID,
      expect.objectContaining({
        categories: [{ categoryId: FOOD, amount: 900_000, alertThreshold: 80 }],
      }),
      AUDIT,
    );
  });

  it('memakai 80 untuk kategori baru tanpa alert_threshold', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.update(USER, BUDGET_ID, { categories: [{ category_id: OTHER_EXPENSE, amount: 10_000 }] }, AUDIT);

    expect(repository.update).toHaveBeenCalledWith(
      USER,
      BUDGET_ID,
      expect.objectContaining({
        categories: [{ categoryId: OTHER_EXPENSE, amount: 10_000, alertThreshold: 80 }],
      }),
      AUDIT,
    );
  });

  it('menghapus alokasi yang tidak dikirim dari perhitungan total', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    // Bila TRANSPORT (2 juta) masih dihitung, 2 juta + 1,5 juta melebihi total 3 juta.
    await service.update(USER, BUDGET_ID, { categories: [{ category_id: FOOD, amount: 1_500_000 }] }, AUDIT);

    expect(repository.update).toHaveBeenCalled();
  });

  it('anggaran tidak ditemukan dijawab 404', async () => {
    const repository = fakeRepository({ findById: vi.fn(async () => null) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.update(USER, BUDGET_ID, { total_amount: 4_000_000 }, AUDIT));

    expect(error.code).toBe('NOT_FOUND');
  });

  it('repository melaporkan not_found di tengah transaksi dijawab 404', async () => {
    const repository = fakeRepository({ update: vi.fn(async () => ({ status: 'not_found' as const })) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.update(USER, BUDGET_ID, { total_amount: 4_000_000 }, AUDIT));

    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('daftar, current, dan summary', () => {
  it('daftar meneruskan status dan hari ini WIB', async () => {
    const repository = fakeRepository();
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    await service.list(USER, { status: 'active' });

    expect(repository.list).toHaveBeenCalledWith(USER, 'active', '2026-10-15');
  });

  it('current 404 bila tidak ada anggaran aktif', async () => {
    const repository = fakeRepository({ findActive: vi.fn(async () => null) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    const error = await rejection(service.current(USER));

    expect(error.code).toBe('NOT_FOUND');
  });

  it('summary null bila tidak ada anggaran aktif', async () => {
    const repository = fakeRepository({ findActive: vi.fn(async () => null) });
    const service = createBudgetsService({ repository, spending: fakeSpending(), now: () => NOW });

    expect(await service.summary(USER)).toBeNull();
  });

  it('summary memakai nama field kontrak total/used/remaining', async () => {
    const service = createBudgetsService({
      repository: fakeRepository(),
      spending: fakeSpending({ total: 2_650_000, byCategory: { [FOOD]: 2_650_000 } }),
      now: () => NOW,
    });

    expect(await service.summary(USER)).toEqual({
      budget_id: BUDGET_ID,
      name: 'Anggaran Oktober',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      total: 3_000_000,
      used: 2_650_000,
      remaining: 350_000,
      percent: 88.3,
      status: 'warning',
    });
  });
});
