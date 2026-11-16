// Aturan job budget-alert dan renew-budgets di service budgets, tanpa database.
// Perilaku SQL (compare-and-set, partial unique, audit system) diuji di
// tests/integration/scheduled.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createBudgetsService } from '../../src/modules/budgets/budgets.service.js';
import type {
  BudgetAlertAudience,
  BudgetAlertAccount,
  BudgetAlertNotifier,
  BudgetRecord,
  BudgetsRepository,
  CreateOutcome,
  SpendingSnapshot,
  UpdateOutcome,
} from '../../src/modules/budgets/budgets.types.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const OTHER_USER = '8e2b1a0d-5a3c-4d7b-8b0e-9c4d6f7a1b2c';
const BUDGET_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_BUDGET_ID = '22222222-2222-4222-8222-222222222222';
const BUDGET_CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_BUDGET_CATEGORY_ID = '44444444-4444-4444-8444-444444444444';
const FOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSPORT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WA = '628123456789@c.us';

const NOW = new Date('2026-11-12T13:00:00.000Z'); // 20.00 WIB
const AT_0659 = new Date('2026-11-11T23:59:00.000Z'); // 06.59 WIB
const AT_0700 = new Date('2026-11-12T00:00:00.000Z'); // 07.00 WIB
const AT_2200 = new Date('2026-11-12T15:00:00.000Z'); // 22.00 WIB

function account(overrides: Partial<BudgetAlertAccount> = {}): BudgetAlertAccount {
  return {
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: USER,
    waChatId: WA,
    status: 'verified',
    budgetAlertEnabled: true,
    userDeletedAt: null,
    ...overrides,
  };
}

function record(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    id: BUDGET_ID,
    userId: USER,
    name: 'November',
    periodType: 'monthly',
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    periodEnd: new Date('2026-11-30T00:00:00.000Z'),
    totalAmount: 1_000_000,
    autoRenew: true,
    rolloverEnabled: false,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    budgetCategories: [
      {
        id: BUDGET_CATEGORY_ID,
        categoryId: FOOD,
        amount: 100_000,
        alertThreshold: 80,
        alertSentAt: null,
        category: { name: 'Makanan', slug: 'food' },
      },
    ],
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<BudgetsRepository> = {}): BudgetsRepository {
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => record()),
    findActive: vi.fn(async () => record()),
    findOverlapping: vi.fn(async () => null),
    findVisibleCategories: vi.fn(async (_userId: string, ids: string[]) =>
      ids.map((id) => ({
        id,
        name: id === FOOD ? 'Makanan' : 'Transportasi',
        slug: id === FOOD ? 'food' : 'transport',
        type: 'expense',
      })),
    ),
    create: vi.fn(async (): Promise<CreateOutcome> => ({ status: 'created', record: record() })),
    update: vi.fn(async (): Promise<UpdateOutcome> => ({ status: 'updated', record: record() })),
    softDelete: vi.fn(async () => true),
    listDueRenewals: vi.fn(async () => []),
    createRenewal: vi.fn(async (): Promise<CreateOutcome> => ({ status: 'created', record: record() })),
    ...overrides,
  };
}

function fakeAudience(rows: BudgetAlertAccount[]): BudgetAlertAudience {
  return {
    list: vi.fn(async (afterAccountId: string | null, limit: number) => {
      const start = afterAccountId ? rows.findIndex((row) => row.accountId === afterAccountId) + 1 : 0;
      return rows.slice(start, start + limit);
    }),
  };
}

function fakeSpending(snapshot: SpendingSnapshot = { total: 0, byCategory: {} }) {
  return { spendingInRange: vi.fn(async () => snapshot) };
}

function arranged(
  options: {
    repository?: BudgetsRepository;
    audience?: BudgetAlertAudience;
    notifier?: BudgetAlertNotifier;
    snapshot?: SpendingSnapshot;
  } = {},
) {
  const repository = options.repository ?? fakeRepository();
  const notifier = options.notifier ?? { deliver: vi.fn(async () => 'sent' as const) };
  const audience = options.audience ?? fakeAudience([account()]);
  const spending = fakeSpending(options.snapshot ?? { total: 80_000, byCategory: { [FOOD]: 80_000 } });
  const service = createBudgetsService({
    repository,
    spending,
    now: () => NOW,
    alerts: { audience, notifier },
  });
  return { service, repository, audience, notifier, spending };
}

describe('scanAlerts', () => {
  it('mengirim tepat pada ambang 80% dengan spent/amount yang benar', async () => {
    const { service, notifier } = arranged();

    const result = await service.scanAlerts(NOW);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(notifier.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        waChatId: WA,
        budgetId: BUDGET_ID,
        budgetCategoryId: BUDGET_CATEGORY_ID,
        categoryId: FOOD,
        categoryName: 'Makanan',
        spent: 80_000,
        amount: 100_000,
        periodStart: '2026-11-01',
        now: NOW,
      }),
    );
  });

  it('tidak mengirim bila pengeluaran satu rupiah di bawah ambang', async () => {
    const { service, notifier } = arranged({
      snapshot: { total: 79_999, byCategory: { [FOOD]: 79_999 } },
    });

    const result = await service.scanAlerts(NOW);

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(notifier.deliver).not.toHaveBeenCalled();
  });

  it('tidak mengirim ulang bila alert_sent_at sudah terisi', async () => {
    const repository = fakeRepository({
      findActive: vi.fn(async () =>
        record({
          budgetCategories: [
            {
              id: BUDGET_CATEGORY_ID,
              categoryId: FOOD,
              amount: 100_000,
              alertThreshold: 80,
              alertSentAt: new Date('2026-11-12T01:00:00Z'),
              category: { name: 'Makanan', slug: 'food' },
            },
          ],
        }),
      ),
    });
    const { service, notifier } = arranged({ repository });

    const result = await service.scanAlerts(NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(notifier.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ['sakelar mati', account({ budgetAlertEnabled: false })],
    ['akun belum verified', account({ status: 'pending' })],
    ['pengguna soft-delete', account({ userDeletedAt: new Date('2026-11-01T00:00:00Z') })],
  ])('melewati akun: %s', async (_label, row) => {
    const { service, notifier } = arranged({ audience: fakeAudience([row]) });

    const result = await service.scanAlerts(NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(notifier.deliver).not.toHaveBeenCalled();
  });

  it('tidak mengirim bila tidak ada anggaran aktif', async () => {
    const repository = fakeRepository({ findActive: vi.fn(async () => null) });
    const { service, notifier } = arranged({ repository });

    const result = await service.scanAlerts(NOW);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(notifier.deliver).not.toHaveBeenCalled();
  });

  it.each([
    ['06.59 WIB', AT_0659],
    ['22.00 WIB', AT_2200],
  ])('tidak memindai di luar jendela 07.00-22.00 WIB: %s', async (_label, now) => {
    const { service, notifier, audience } = arranged();

    const result = await service.scanAlerts(now);

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(audience.list).not.toHaveBeenCalled();
    expect(notifier.deliver).not.toHaveBeenCalled();
  });

  it('memindai tepat pada 07.00 WIB', async () => {
    const { service, notifier } = arranged();

    const result = await service.scanAlerts(AT_0700);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(notifier.deliver).toHaveBeenCalled();
  });

  it('memakai awal periode anggaran yang sedang aktif (pergantian bulan)', async () => {
    const repository = fakeRepository({
      findActive: vi.fn(async () =>
        record({
          periodStart: new Date('2026-12-01T00:00:00.000Z'),
          periodEnd: new Date('2026-12-31T00:00:00.000Z'),
        }),
      ),
    });
    const { service, notifier } = arranged({ repository });

    await service.scanAlerts(NOW);

    expect(notifier.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ periodStart: '2026-12-01' }),
    );
  });
});

describe('renew', () => {
  const oldBudget = (overrides: Partial<BudgetRecord> = {}): BudgetRecord =>
    record({
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-31T00:00:00.000Z'),
      budgetCategories: [
        {
          id: BUDGET_CATEGORY_ID,
          categoryId: FOOD,
          amount: 100_000,
          alertThreshold: 80,
          alertSentAt: new Date('2026-10-20T00:00:00Z'),
          category: { name: 'Makanan', slug: 'food' },
        },
        {
          id: OTHER_BUDGET_CATEGORY_ID,
          categoryId: TRANSPORT,
          amount: 200_000,
          alertThreshold: 100,
          alertSentAt: null,
          category: { name: 'Transportasi', slug: 'transport' },
        },
      ],
      ...overrides,
    });

  it('membuat hanya periode yang memuat hari ini dan menyalin alokasi yang terlihat', async () => {
    const repository = fakeRepository({
      listDueRenewals: vi.fn(async () => [oldBudget()]),
      findActive: vi.fn(async () => null),
      // Transportasi sudah soft-delete: hanya Makanan yang tersisa.
      findVisibleCategories: vi.fn(async () => [
        { id: FOOD, name: 'Makanan', slug: 'food', type: 'expense' },
      ]),
    });
    const { service } = arranged({ repository });

    const result = await service.renew(NOW);

    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(repository.createRenewal).toHaveBeenCalledWith(USER, {
      name: 'November',
      periodType: 'monthly',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      totalAmount: 1_000_000,
      autoRenew: true,
      rolloverEnabled: false,
      categories: [{ categoryId: FOOD, amount: 100_000, alertThreshold: 80 }],
    });
  });

  it('tidak membuat anggaran bila periode berjalan sudah ada', async () => {
    const repository = fakeRepository({
      listDueRenewals: vi.fn(async () => [oldBudget()]),
      findActive: vi.fn(async () => record()),
    });
    const { service } = arranged({ repository });

    const result = await service.renew(NOW);

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(repository.createRenewal).not.toHaveBeenCalled();
  });

  it('menghitung bentrok unique sebagai sudah ada, bukan galat', async () => {
    const repository = fakeRepository({
      listDueRenewals: vi.fn(async () => [oldBudget()]),
      findActive: vi.fn(async () => null),
      createRenewal: vi.fn(async () => ({ status: 'conflict' as const })),
    });
    const { service } = arranged({ repository });

    const result = await service.renew(NOW);

    expect(result).toEqual({ created: 0, skipped: 1 });
  });

  it('hanya memakai anggaran terbaru bila satu pengguna punya beberapa periode terlewat', async () => {
    const older = oldBudget({
      id: OTHER_BUDGET_ID,
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-30T00:00:00.000Z'),
      name: 'September',
    });
    const latest = oldBudget();
    const repository = fakeRepository({
      // Urutan dari repository: pengguna, lalu periode terbaru.
      listDueRenewals: vi.fn(async () => [latest, older]),
      findActive: vi.fn(async () => null),
    });
    const { service } = arranged({ repository });

    await service.renew(NOW);

    expect(repository.createRenewal).toHaveBeenCalledTimes(1);
    expect(repository.createRenewal).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ name: 'November', periodStart: '2026-11-01' }),
    );
  });

  it('memproses pengguna berbeda masing-masing satu kali', async () => {
    const repository = fakeRepository({
      listDueRenewals: vi.fn(async () => [
        oldBudget(),
        oldBudget({ id: OTHER_BUDGET_ID, userId: OTHER_USER }),
      ]),
      findActive: vi.fn(async () => null),
    });
    const { service } = arranged({ repository });

    const result = await service.renew(NOW);

    expect(result).toEqual({ created: 2, skipped: 0 });
    expect(repository.createRenewal).toHaveBeenCalledTimes(2);
  });
});
