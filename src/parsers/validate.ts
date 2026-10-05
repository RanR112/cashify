// Tahap 6: validasi, deterministik tanpa pengecualian. Pemeriksaan terakhir sebelum sebuah
// transaksi dinyatakan siap dikonfirmasi. Bahwa kategori benar-benar ada di database adalah
// urusan pemanggil; parser tidak membaca database.

import { MAX_DESCRIPTION_LENGTH, MAX_TRANSACTION_AMOUNT } from '../shared/constants/limits.js';
import { isValidDateString, oneYearBefore } from '../shared/utils/timezone.js';
import type { CalendarDate, RejectReason } from './types.js';

export interface TransactionDraft {
  amount: number;
  date: CalendarDate;
  /** Tanggal hari ini di Asia/Jakarta. */
  today: CalendarDate;
}

export type DraftCheck = { ok: true } | { ok: false; reason: RejectReason };

export function validateDraft({ amount, date, today }: TransactionDraft): DraftCheck {
  // Bilangan bulat positif dalam rentang wajar (aturan 1). Pecahan atau NaN tidak mungkin keluar
  // dari tahap 3; bila sampai sini, perlakukan seperti nol, jangan disimpan.
  if (amount < 0) return { ok: false, reason: 'amount_negative' };
  if (!Number.isInteger(amount) || amount === 0) return { ok: false, reason: 'amount_zero' };
  if (amount > MAX_TRANSACTION_AMOUNT) return { ok: false, reason: 'amount_too_large' };

  if (!isValidDateString(date)) return { ok: false, reason: 'date_invalid' };
  if (date > today) return { ok: false, reason: 'date_future' };
  if (date < oneYearBefore(today)) return { ok: false, reason: 'date_too_old' };

  return { ok: true };
}

/** Catatan transaksi: spasi dirapikan dan dipotong ke batas kolom. */
export function limitDescription(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH).trimEnd();
}
