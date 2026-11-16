import { addDays, currentMonthInJakarta, lastMonths, monthBounds } from '../../shared/utils/timezone.js';
import type {
  MonthlyReportBody,
  MonthlyReportQuery,
  ReportCategoryTotal,
  SummaryReader,
  TrendReportBody,
  TrendReportQuery,
} from './reports.types.js';

/** Satu desimal; pembagian nol menghasilkan 0 (bukan NaN). */
function percentOf(total: number, typeTotal: number): number {
  if (typeTotal <= 0) return 0;
  return Math.round((total / typeTotal) * 1000) / 10;
}

/** Setiap tanggal dalam rentang inklusif, urut menaik. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export interface ReportsServiceDeps {
  summary: SummaryReader;
  /** Bisa disuntik untuk test; menentukan bulan bawaan. */
  now?: () => Date;
}

export function createReportsService({ summary, now = () => new Date() }: ReportsServiceDeps) {
  return {
    async monthly(userId: string, query: MonthlyReportQuery): Promise<MonthlyReportBody> {
      const month = query.month ?? currentMonthInJakarta(now());
      const range = monthBounds(month);

      const [totals, categories, dailyRows] = await Promise.all([
        summary.sumByType(userId, range),
        summary.categoryTotals(userId, range),
        summary.dailyCashflow(userId, range),
      ]);

      const typeTotals: Record<ReportCategoryTotal['type'], number> = {
        income: totals.income,
        expense: totals.expense,
      };

      const byCategory = categories
        .map((category) => ({
          category_id: category.categoryId,
          name: category.name,
          slug: category.slug,
          type: category.type,
          total: category.total,
          percent: percentOf(category.total, typeTotals[category.type]),
        }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'id'));

      const byDate = new Map(dailyRows.map((row) => [row.date, row]));

      return {
        month,
        income_total: totals.income,
        expense_total: totals.expense,
        net: totals.income - totals.expense,
        by_category: byCategory,
        daily: datesBetween(range.from, range.to).map((date) => {
          const row = byDate.get(date);
          return { date, income: row?.income ?? 0, expense: row?.expense ?? 0 };
        }),
      };
    },

    async trend(userId: string, query: TrendReportQuery): Promise<TrendReportBody> {
      const months = lastMonths(currentMonthInJakarta(now()), query.months);
      const rows = await Promise.all(
        months.map(async (month) => {
          const totals = await summary.sumByType(userId, monthBounds(month));
          return {
            month,
            income: totals.income,
            expense: totals.expense,
            net: totals.income - totals.expense,
          };
        }),
      );
      return { months: rows };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
