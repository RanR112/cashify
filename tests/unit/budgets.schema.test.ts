import { describe, expect, it } from 'vitest';
import {
  budgetListQuerySchema,
  createBudgetBodySchema,
  updateBudgetBodySchema,
} from '../../src/modules/budgets/budgets.schema.js';
import { MAX_INT32 } from '../../src/shared/constants/limits.js';

const FOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSPORT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const createBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Anggaran Oktober',
  period_type: 'monthly',
  period_start: '2026-10-01',
  total_amount: 3_000_000,
  categories: [{ category_id: FOOD, amount: 1_000_000 }],
  ...overrides,
});

describe('createBudgetBodySchema', () => {
  it('menerima body minimal dan mengisi nilai bawaan', () => {
    const parsed = createBudgetBodySchema.parse(createBody());

    expect(parsed.auto_renew).toBe(true);
    expect(parsed.rollover_enabled).toBe(false);
    expect(parsed.categories[0]?.alert_threshold).toBe(80);
  });

  it('menerima weekly dan nama opsional', () => {
    expect(createBudgetBodySchema.safeParse(createBody({ period_type: 'weekly', name: undefined })).success).toBe(true);
  });

  it.each([
    ['total nol', { total_amount: 0 }],
    ['total negatif', { total_amount: -1 }],
    ['total desimal', { total_amount: 1_000_000.5 }],
    ['total di atas MAX_INT32', { total_amount: MAX_INT32 + 1 }],
    ['period_type tak dikenal', { period_type: 'yearly' }],
    ['period_start bukan tanggal', { period_start: '2026-13-01' }],
    ['kategori kosong', { categories: [] }],
    ['nama kosong', { name: '' }],
    ['nama lebih dari 100 karakter', { name: 'x'.repeat(101) }],
  ])('menolak %s', (_label, override) => {
    expect(createBudgetBodySchema.safeParse(createBody(override)).success).toBe(false);
  });

  it.each([
    ['amount nol', { category_id: FOOD, amount: 0 }],
    ['amount negatif', { category_id: FOOD, amount: -1 }],
    ['alert_threshold nol', { category_id: FOOD, amount: 1_000, alert_threshold: 0 }],
    ['alert_threshold di atas 100', { category_id: FOOD, amount: 1_000, alert_threshold: 101 }],
    ['category_id bukan UUID', { category_id: 'makanan', amount: 1_000 }],
  ])('menolak kategori dengan %s', (_label, category) => {
    expect(createBudgetBodySchema.safeParse(createBody({ categories: [category] })).success).toBe(false);
  });

  it('menolak category_id ganda', () => {
    const body = createBody({
      categories: [
        { category_id: FOOD, amount: 1_000 },
        { category_id: FOOD, amount: 2_000 },
      ],
    });
    expect(createBudgetBodySchema.safeParse(body).success).toBe(false);
  });

  it('menolak jumlah alokasi melebihi total_amount', () => {
    const body = createBody({
      total_amount: 2_500,
      categories: [
        { category_id: FOOD, amount: 1_000 },
        { category_id: TRANSPORT, amount: 2_000 },
      ],
    });
    expect(createBudgetBodySchema.safeParse(body).success).toBe(false);
  });

  it('menerima jumlah alokasi tepat sama dengan total_amount', () => {
    const body = createBody({
      total_amount: 3_000,
      categories: [
        { category_id: FOOD, amount: 1_000 },
        { category_id: TRANSPORT, amount: 2_000 },
      ],
    });
    expect(createBudgetBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('updateBudgetBodySchema', () => {
  it('menerima satu field saja', () => {
    expect(updateBudgetBodySchema.safeParse({ total_amount: 4_000_000 }).success).toBe(true);
    expect(updateBudgetBodySchema.safeParse({ categories: [{ category_id: FOOD, amount: 500 }] }).success).toBe(true);
  });

  it('menolak body kosong', () => {
    expect(updateBudgetBodySchema.safeParse({}).success).toBe(false);
  });

  it.each(['period_type', 'period_start', 'period_end'])('menolak %s yang tidak boleh diubah', (field) => {
    const result = updateBudgetBodySchema.safeParse({ [field]: '2026-11-01' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual([field]);
  });

  it('mengabaikan field tak dikenal lain, bukan menolaknya', () => {
    expect(updateBudgetBodySchema.safeParse({ total_amount: 4_000_000, catatan: 'x' }).success).toBe(true);
  });

  it('alert_threshold opsional di PATCH, tetap wajib bila dikirim', () => {
    expect(
      updateBudgetBodySchema.safeParse({ categories: [{ category_id: FOOD, amount: 1_000 }] }).success,
    ).toBe(true);
    expect(
      updateBudgetBodySchema.safeParse({
        categories: [{ category_id: FOOD, amount: 1_000, alert_threshold: 101 }],
      }).success,
    ).toBe(false);
  });

  it('menolak kategori ganda', () => {
    const body = {
      categories: [
        { category_id: FOOD, amount: 1_000 },
        { category_id: FOOD, amount: 2_000 },
      ],
    };
    expect(updateBudgetBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('budgetListQuerySchema', () => {
  it('bawaan all, menerima active', () => {
    expect(budgetListQuerySchema.parse({}).status).toBe('all');
    expect(budgetListQuerySchema.parse({ status: 'active' }).status).toBe('active');
  });

  it('menolak status lain', () => {
    expect(budgetListQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});
