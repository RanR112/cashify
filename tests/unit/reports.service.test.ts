// Test unit service reports dengan SummaryReader palsu. Perilaku SQL (batas bulan, soft delete,
// isolasi pengguna) diuji di tests/integration/reports.test.ts; fake di bawah hanya meniru
// kontrak port.

import { describe, expect, it, vi } from 'vitest';
import {
  monthlyReportQuerySchema,
  monthlyReportSchema,
  trendReportQuerySchema,
} from '../../src/modules/reports/reports.schema.js';
import { createReportsService } from '../../src/modules/reports/reports.service.js';
import type {
  ReportCategoryTotal,
  ReportDailyTotal,
  ReportRange,
  ReportTotals,
  SummaryReader,
} from '../../src/modules/reports/reports.types.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';

const FOOD = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Makanan', slug: 'food', type: 'expense' as const };
const TRANSPORT = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Transportasi',
  slug: 'transport',
  type: 'expense' as const,
};
const SALARY = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Gaji', slug: 'salary', type: 'income' as const };
const OTHER = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Lainnya', slug: 'other', type: 'expense' as const };

interface LedgerRow {
  date: string;
  type: 'income' | 'expense';
  amount: number;
  category: typeof FOOD | typeof TRANSPORT | typeof SALARY | typeof OTHER;
}

const inRange = (row: LedgerRow, range: ReportRange): boolean => row.date >= range.from && row.date <= range.to;

/** Fake ledger yang meniru kontrak SummaryReader, termasuk urutan kategori dan hari berisi data. */
function fakeSummary(rows: LedgerRow[]): SummaryReader {
  return {
    sumByType: vi.fn(async (_userId: string, range: ReportRange): Promise<ReportTotals> => {
      const totals: ReportTotals = { income: 0, expense: 0 };
      for (const row of rows.filter((item) => inRange(item, range))) totals[row.type] += row.amount;
      return totals;
    }),

    categoryTotals: vi.fn(async (_userId: string, range: ReportRange): Promise<ReportCategoryTotal[]> => {
      const byCategory = new Map<string, ReportCategoryTotal>();
      for (const row of rows.filter((item) => inRange(item, range))) {
        const entry = byCategory.get(row.category.id) ?? {
          categoryId: row.category.id,
          name: row.category.name,
          slug: row.category.slug,
          type: row.category.type,
          total: 0,
        };
        entry.total += row.amount;
        byCategory.set(row.category.id, entry);
      }
      return [...byCategory.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'id'));
    }),

    dailyCashflow: vi.fn(async (_userId: string, range: ReportRange): Promise<ReportDailyTotal[]> => {
      const byDate = new Map<string, ReportDailyTotal>();
      for (const row of rows.filter((item) => inRange(item, range))) {
        const entry = byDate.get(row.date) ?? { date: row.date, income: 0, expense: 0 };
        entry[row.type] += row.amount;
        byDate.set(row.date, entry);
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    }),
  };
}

describe('validasi query reports', () => {
  it('month opsional dan harus YYYY-MM dengan bulan 01-12', () => {
    expect(monthlyReportQuerySchema.parse({}).month).toBeUndefined();
    expect(monthlyReportQuerySchema.parse({ month: '2026-10' }).month).toBe('2026-10');
    for (const month of ['2026-13', '2026-00', '2026-9', '2026-10-01', 'Oktober-2026', '']) {
      expect(monthlyReportQuerySchema.safeParse({ month }).success, month).toBe(false);
    }
  });

  it('months di-coerce, default 6, dan dibatasi 1-12', () => {
    expect(trendReportQuerySchema.parse({}).months).toBe(6);
    expect(trendReportQuerySchema.parse({ months: '12' }).months).toBe(12);
    expect(trendReportQuerySchema.parse({ months: '1' }).months).toBe(1);
    for (const months of ['0', '13', '1.5', 'abc', '']) {
      expect(trendReportQuerySchema.safeParse({ months }).success, months).toBe(false);
    }
  });
});

describe('createReportsService.monthly', () => {
  const service = (rows: LedgerRow[], now?: Date) =>
    createReportsService({ summary: fakeSummary(rows), ...(now && { now: () => now }) });

  it('menghitung total, net, persen per tipe, dan urutan total menurun', async () => {
    const result = await service([
      { date: '2026-10-01', type: 'income', amount: 5_000_000, category: SALARY },
      { date: '2026-10-02', type: 'expense', amount: 200_000, category: FOOD },
      { date: '2026-10-03', type: 'expense', amount: 400_000, category: TRANSPORT },
    ]).monthly(USER, { month: '2026-10' });

    expect(monthlyReportSchema.parse(result)).toEqual(result);
    expect(result.month).toBe('2026-10');
    expect(result.income_total).toBe(5_000_000);
    expect(result.expense_total).toBe(600_000);
    expect(result.net).toBe(4_400_000);
    expect(result.by_category.map((item) => item.name)).toEqual(['Gaji', 'Transportasi', 'Makanan']);
    expect(result.by_category.find((item) => item.name === 'Gaji')?.percent).toBe(100);
    expect(result.by_category.find((item) => item.name === 'Makanan')?.percent).toBe(33.3);
    expect(result.by_category.find((item) => item.name === 'Transportasi')?.percent).toBe(66.7);
    expect(result.daily).toHaveLength(31);
  });

  it('bulan tanpa data: nol, kategori kosong, dan setiap tanggal tetap ada', async () => {
    const result = await service([]).monthly(USER, { month: '2028-02' });

    expect(result).toMatchObject({ month: '2028-02', income_total: 0, expense_total: 0, net: 0, by_category: [] });
    expect(result.daily).toHaveLength(29); // 2028 kabisat
    expect(result.daily[0]).toEqual({ date: '2028-02-01', income: 0, expense: 0 });
    expect(result.daily.at(-1)).toEqual({ date: '2028-02-29', income: 0, expense: 0 });
  });

  it('pembagian nol menghasilkan persen 0, bukan NaN', async () => {
    const summary = fakeSummary([]);
    summary.categoryTotals = vi.fn(async (): Promise<ReportCategoryTotal[]> => [
      { categoryId: SALARY.id, name: SALARY.name, slug: SALARY.slug, type: 'income', total: 0 },
    ]);
    const result = await createReportsService({ summary }).monthly(USER, { month: '2026-10' });

    expect(result.by_category).toEqual([
      { category_id: SALARY.id, name: 'Gaji', slug: 'salary', type: 'income', total: 0, percent: 0 },
    ]);
  });

  it('jumlah persen boleh 99,9 karena pembulatan', async () => {
    const result = await service([
      { date: '2026-10-01', type: 'expense', amount: 1, category: FOOD },
      { date: '2026-10-02', type: 'expense', amount: 1, category: TRANSPORT },
      { date: '2026-10-03', type: 'expense', amount: 1, category: OTHER },
    ]).monthly(USER, { month: '2026-10' });

    const total = result.by_category.reduce((sum, item) => sum + item.percent, 0);
    expect(total).toBeCloseTo(99.9, 5);
  });

  it('bulan bawaan memakai kalender Asia/Jakarta dan bisa disuntik', async () => {
    const summary = fakeSummary([]);
    const result = await createReportsService({
      summary,
      // 2026-09-30 17:30 UTC = 2026-10-01 00:30 WIB
      now: () => new Date('2026-09-30T17:30:00Z'),
    }).monthly(USER, {});

    expect(result.month).toBe('2026-10');
    expect(summary.sumByType).toHaveBeenCalledWith(USER, { from: '2026-10-01', to: '2026-10-31' });
  });
});

describe('createReportsService.trend', () => {
  it('urut menaik, panjang sesuai N, dan bulan kosong tetap nol', async () => {
    const service = createReportsService({
      summary: fakeSummary([
        { date: '2026-08-01', type: 'income', amount: 1_000, category: SALARY },
        { date: '2026-10-01', type: 'expense', amount: 500, category: FOOD },
      ]),
      now: () => new Date('2026-10-20T00:00:00Z'),
    });

    const result = await service.trend(USER, { months: 3 });

    expect(result.months).toEqual([
      { month: '2026-08', income: 1_000, expense: 0, net: 1_000 },
      { month: '2026-09', income: 0, expense: 0, net: 0 },
      { month: '2026-10', income: 0, expense: 500, net: -500 },
    ]);
  });

  it('satu bulan hanya berisi bulan berjalan', async () => {
    const result = await createReportsService({
      summary: fakeSummary([{ date: '2026-01-15', type: 'expense', amount: 25_000, category: FOOD }]),
      now: () => new Date('2026-01-20T00:00:00Z'),
    }).trend(USER, { months: 1 });

    expect(result.months).toEqual([{ month: '2026-01', income: 0, expense: 25_000, net: -25_000 }]);
  });
});
