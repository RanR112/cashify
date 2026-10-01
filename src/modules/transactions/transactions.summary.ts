// Kueri agregasi transaksi. Hanya membaca, tanpa endpoint HTTP sendiri: dipakai modul
// `dashboard` (agregator) dan kelak `reports`. Dipisah dari repository karena kueri
// agregasi tumbuh sendiri dan tidak ikut aturan paginasi/audit di sana.
//
// Semua kueri memfilter pemilik dan mengecualikan transaksi yang di-soft-delete (ownedBy).
// `date` adalah tanggal kalender Jakarta (generated column), jadi rentang `from`/`to` inklusif
// langsung benar di batas hari dan bulan tanpa konversi zona waktu.

import type { PrismaClient } from '@prisma/client';
import { ownedBy } from '../../shared/utils/userScope.js';

export interface DateRange {
  /** `YYYY-MM-DD`, inklusif. */
  from?: string;
  to?: string;
}

export interface PeriodTotals {
  income: number;
  expense: number;
}

export interface DailyCashflow extends PeriodTotals {
  date: string;
}

const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

function dateFilter({ from, to }: DateRange) {
  if (!from && !to) return {};
  return { date: { ...(from && { gte: dateOf(from) }), ...(to && { lte: dateOf(to) }) } };
}

export function createTransactionsSummary(prisma: PrismaClient) {
  return {
    /** Total pemasukan dan pengeluaran dalam rentang; rentang kosong berarti seluruh waktu. */
    async sumByType(userId: string, range: DateRange = {}): Promise<PeriodTotals> {
      const groups = await prisma.transaction.groupBy({
        by: ['type'],
        where: { ...ownedBy(userId), ...dateFilter(range) },
        _sum: { amount: true },
      });
      const totals: PeriodTotals = { income: 0, expense: 0 };
      for (const group of groups) {
        if (group.type === 'income' || group.type === 'expense') totals[group.type] = group._sum.amount ?? 0;
      }
      return totals;
    },

    /** Satu entri per hari yang punya transaksi, naik menurut tanggal. */
    async dailyCashflow(userId: string, range: Required<DateRange>): Promise<DailyCashflow[]> {
      const groups = await prisma.transaction.groupBy({
        by: ['date', 'type'],
        where: { ...ownedBy(userId), ...dateFilter(range) },
        _sum: { amount: true },
      });

      const byDate = new Map<string, DailyCashflow>();
      for (const group of groups) {
        const date = group.date.toISOString().slice(0, 10);
        const entry = byDate.get(date) ?? { date, income: 0, expense: 0 };
        if (group.type === 'income' || group.type === 'expense') entry[group.type] = group._sum.amount ?? 0;
        byDate.set(date, entry);
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
  };
}

export type TransactionsSummary = ReturnType<typeof createTransactionsSummary>;
