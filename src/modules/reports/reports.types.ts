// Modul reports tidak punya repository. Service hanya memakai port di bawah ini; implementasi
// nyatanya ada di transactions.summary.ts dan dirakit di src/app.ts. Karena itu berkas ini
// mendefinisikan bentuk data sendiri dan TIDAK mengimpor modul transactions.

import type { z } from 'zod';
import type {
  monthlyReportSchema,
  monthlyReportQuerySchema,
  trendReportQuerySchema,
  trendReportSchema,
} from './reports.schema.js';

export type MonthlyReportQuery = z.infer<typeof monthlyReportQuerySchema>;
export type TrendReportQuery = z.infer<typeof trendReportQuerySchema>;
export type MonthlyReportBody = z.infer<typeof monthlyReportSchema>;
export type TrendReportBody = z.infer<typeof trendReportSchema>;

/** Rentang tanggal kalender inklusif, `YYYY-MM-DD`. */
export interface ReportRange {
  from: string;
  to: string;
}

export interface ReportTotals {
  income: number;
  expense: number;
}

export interface ReportCategoryTotal {
  categoryId: string;
  name: string;
  slug: string;
  type: 'income' | 'expense';
  total: number;
}

export interface ReportDailyTotal extends ReportTotals {
  date: string;
}

/**
 * Port pembaca agregasi transaksi. Semua metode wajib memfilter pemilik (`user_id` dari JWT)
 * dan mengecualikan transaksi yang di-soft-delete; itu tanggung jawab implementasinya di
 * transactions.summary.ts, bukan service reports.
 */
export interface SummaryReader {
  sumByType(userId: string, range: ReportRange): Promise<ReportTotals>;
  categoryTotals(userId: string, range: ReportRange): Promise<ReportCategoryTotal[]>;
  dailyCashflow(userId: string, range: ReportRange): Promise<ReportDailyTotal[]>;
}
