import { currentMonthInJakarta, monthBounds } from '../../shared/utils/timezone.js';
import type {
  DashboardBody,
  DashboardQuery,
  DashboardSummary,
  DashboardTransactions,
  DashboardUsers,
} from './dashboard.types.js';

/** Hingga 10 menurut claude/API.md bagian 5; beranda menampilkan 5. */
export const RECENT_TRANSACTIONS_LIMIT = 5;

export interface DashboardServiceDeps {
  users: DashboardUsers;
  transactions: DashboardTransactions;
  summary: DashboardSummary;
  /** Bisa disuntik untuk test; menentukan bulan bawaan. */
  now?: () => Date;
}

/**
 * Agregator: satu-satunya modul yang memanggil service modul lain, dan tidak menyentuh
 * database sendiri. Seluruh kueri baris lewat service/summary yang sudah memfilter pemilik
 * dan mengecualikan transaksi yang di-soft-delete.
 */
export function createDashboardService({ users, transactions, summary, now = () => new Date() }: DashboardServiceDeps) {
  return {
    async get(userId: string, email: string, query: DashboardQuery): Promise<DashboardBody> {
      const month = query.month ?? currentMonthInJakarta(now());
      const range = monthBounds(month);

      const [profile, allTime, monthTotals, cashflow, recent] = await Promise.all([
        users.getMe(userId, email),
        summary.sumByType(userId),
        summary.sumByType(userId, range),
        summary.dailyCashflow(userId, range),
        transactions.list(userId, { limit: RECENT_TRANSACTIONS_LIMIT }),
      ]);

      return {
        // Saldo SELALU dihitung, tidak pernah disimpan: kolom saldo akan menyimpang dari
        // kenyataan pada kegagalan pertama. Seluruh waktu, tidak bergantung pada `month`.
        balance: profile.initial_balance + allTime.income - allTime.expense,
        month: {
          income: monthTotals.income,
          expense: monthTotals.expense,
          net: monthTotals.income - monthTotals.expense,
        },
        cashflow,
        recent_transactions: recent.data,
      };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
