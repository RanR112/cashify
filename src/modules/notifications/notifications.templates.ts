// Teks pesan notifikasi otomatis. Seperti whatsapp.templates.ts (aturan 3): seluruh kalimat
// dirakit dari template, tidak pernah dari keluaran LLM. Fungsi di sini murni: tanpa Prisma,
// tanpa jaringan, tanpa jam sistem (tanggal datang sebagai argumen).
//
// Nada mengikuti balasan bot: Indonesia informal, ringkas, maksimal LIMA baris, maksimal SATU
// emoji dan hanya di awal. Panjang pesan dijaga di bawah 600 karakter.
//
// Daftar bulan disalin dari whatsapp.templates.ts, bukan diimpor: modul tidak boleh saling
// mengimpor, dan fungsinya cukup kecil untuk tidak jadi sumber kebenaran bersama.

import { formatRupiah } from '../../shared/utils/money.js';

export const DAILY_SUMMARY_TITLE = 'Ringkasan harian';
export const BUDGET_ALERT_TITLE = 'Peringatan anggaran';

/** Nama kategori dipotong agar satu baris tidak memanjang. */
const MAX_CATEGORY_LENGTH = 40;
/** Nama anggaran boleh lebih panjang, tetapi tetap dipotong. */
const MAX_BUDGET_NAME_LENGTH = 60;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] as const;

const lines = (...parts: (string | null | undefined | false)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join('\n');

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "2026-09-28" -> "28 Sep". Ringkasan selalu untuk hari yang baru berjalan, jadi tahun tidak ditulis. */
function shortDate(date: string): string {
  const [, month = '', day = ''] = date.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
}

/** Persen satu desimal; pembagian nol menghasilkan 0 (bukan Infinity/NaN). */
export function percentUsed(spent: number, amount: number): number {
  if (amount <= 0) return 0;
  return Math.round((spent / amount) * 1000) / 10;
}

/** 85 -> "85%"; 85.5 -> "85,5%" (koma desimal Indonesia). */
function formatPercent(percent: number): string {
  return `${String(percent).replace('.', ',')}%`;
}

export interface DailySummaryView {
  /** Tanggal kalender Jakarta, `YYYY-MM-DD`. */
  date: string;
  /** Total pemasukan hari itu, rupiah penuh. */
  income: number;
  /** Total pengeluaran hari itu, rupiah penuh. */
  expense: number;
  /** Kategori pengeluaran terbesar; null/undefined bila tidak ada pengeluaran. */
  topExpenseCategory?: { name: string; total: number } | null;
}

export function dailySummary(view: DailySummaryView): string {
  const top = view.topExpenseCategory;
  return lines(
    `📊 Ringkasan ${shortDate(view.date)}`,
    `Masuk: ${formatRupiah(view.income)}`,
    `Keluar: ${formatRupiah(view.expense)}`,
    `Selisih: ${formatRupiah(view.income - view.expense)}`,
    top && `Terbesar: ${clip(top.name, MAX_CATEGORY_LENGTH)} ${formatRupiah(top.total)}`,
  );
}

export interface BudgetAlertView {
  /** `budgets.name` boleh null. */
  budgetName: string | null;
  categoryName: string;
  /** Pengeluaran kategori ini dalam periode, rupiah penuh. */
  spent: number;
  /** Alokasi kategori ini, rupiah penuh (> 0 menurut CHECK database). */
  amount: number;
}

export function budgetAlert(view: BudgetAlertView): string {
  return lines(
    `⚠️ Anggaran ${clip(view.categoryName, MAX_CATEGORY_LENGTH)}`,
    `Terpakai ${formatRupiah(view.spent)} dari ${formatRupiah(view.amount)} ` +
      `(${formatPercent(percentUsed(view.spent, view.amount))}).`,
    `Anggaran: ${clip(view.budgetName ?? 'tanpa nama', MAX_BUDGET_NAME_LENGTH)}`,
  );
}
