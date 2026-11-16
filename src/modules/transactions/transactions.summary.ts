// Kueri agregasi transaksi. Hanya membaca, tanpa endpoint HTTP sendiri: dipakai modul
// `dashboard` (agregator), `reports`, dan `budgets` (lewat port `SpendingReader`). Dipisah
// dari repository karena kueri agregasi tumbuh sendiri dan tidak ikut aturan paginasi/audit
// di sana.
//
// Semua kueri memfilter pemilik dan mengecualikan transaksi yang di-soft-delete (ownedBy).
// `date` adalah tanggal kalender Jakarta (generated column), jadi rentang `from`/`to` inklusif
// langsung benar di batas hari dan bulan tanpa konversi zona waktu.

import type { PrismaClient } from '@prisma/client';
import { ownedBy, requireUserId } from '../../shared/utils/userScope.js';

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

/** Total satu kategori dalam rentang; `type` mengikuti tipe kategori. */
export interface CategoryTotal {
  categoryId: string;
  name: string;
  slug: string;
  type: 'income' | 'expense';
  total: number;
}

/** Pengeluaran satu periode beserta rinciannya per kategori. */
export interface SpendingSnapshot {
  total: number;
  /** `category_id` -> total pengeluaran; kategori tanpa pengeluaran tidak muncul. */
  byCategory: Record<string, number>;
}

/** Isi ringkasan harian; bentuknya sengaja sama dengan port di modul notifications. */
export interface TransactionDailySummary {
  income: number;
  expense: number;
  topExpenseCategory: { name: string; total: number } | null;
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

    /**
     * Total pengeluaran dalam rentang dan rinciannya per kategori, satu kueri agregasi.
     * Dipakai port `SpendingReader` modul budgets: `total` mencakup semua kategori,
     * termasuk yang tidak dialokasikan ke anggaran.
     */
    async spendingInRange(userId: string, range: Required<DateRange>): Promise<SpendingSnapshot> {
      const groups = await prisma.transaction.groupBy({
        by: ['categoryId'],
        where: { ...ownedBy(userId), type: 'expense', ...dateFilter(range) },
        _sum: { amount: true },
      });

      const byCategory: Record<string, number> = {};
      let total = 0;
      for (const group of groups) {
        const amount = group._sum.amount ?? 0;
        byCategory[group.categoryId] = amount;
        total += amount;
      }
      return { total, byCategory };
    },

    /**
     * Ringkasan satu tanggal kalender Jakarta untuk job `daily-summary`: total pemasukan,
     * total pengeluaran, dan kategori pengeluaran terbesar. Dua kueri kecil; transaksi tanpa
     * kategori pengeluaran menghasilkan `topExpenseCategory = null`.
     */
    async dailySummary(userId: string, date: string): Promise<TransactionDailySummary> {
      const owner = requireUserId(userId);
      const groups = await prisma.transaction.groupBy({
        by: ['type'],
        where: { ...ownedBy(owner), date: dateOf(date) },
        _sum: { amount: true },
      });

      let income = 0;
      let expense = 0;
      for (const group of groups) {
        if (group.type === 'income') income = group._sum.amount ?? 0;
        if (group.type === 'expense') expense = group._sum.amount ?? 0;
      }

      const top = await prisma.$queryRaw<Array<{ name: string; total: bigint }>>`
        SELECT c.name,
               SUM(t.amount)::bigint AS total
        FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = ${owner}::uuid
          AND t.deleted_at IS NULL
          AND t.date = ${date}::date
          AND t.type = 'expense'
        GROUP BY c.id, c.name
        ORDER BY SUM(t.amount) DESC, c.name ASC
        LIMIT 1
      `;

      return {
        income,
        expense,
        topExpenseCategory: top[0] ? { name: top[0].name, total: Number(top[0].total) } : null,
      };
    },

    /**
     * Total pemasukan/pengeluaran per kategori dalam rentang, urut total menurun.
     * `JOIN` langsung ke categories supaya nama dan slug ikut pada query agregasi. Kategori
     * yang sudah soft-deleted tidak difilter: transaksi lama masih merujuknya.
     */
    async categoryTotals(userId: string, range: Required<DateRange>): Promise<CategoryTotal[]> {
      const owner = requireUserId(userId);
      const rows = await prisma.$queryRaw<
        Array<{ category_id: string; name: string; slug: string; type: string; total: bigint }>
      >`
        SELECT c.id AS category_id,
               c.name,
               c.slug,
               c.type,
               SUM(t.amount)::bigint AS total
        FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = ${owner}::uuid
          AND t.deleted_at IS NULL
          AND t.date >= ${range.from}::date
          AND t.date <= ${range.to}::date
        GROUP BY c.id, c.name, c.slug, c.type
        ORDER BY SUM(t.amount) DESC, c.name ASC
      `;

      const totals: CategoryTotal[] = [];
      for (const row of rows) {
        if (row.type !== 'income' && row.type !== 'expense') continue;
        totals.push({
          categoryId: row.category_id,
          name: row.name,
          slug: row.slug,
          type: row.type,
          total: Number(row.total),
        });
      }
      return totals;
    },
  };
}

export type TransactionsSummary = ReturnType<typeof createTransactionsSummary>;
