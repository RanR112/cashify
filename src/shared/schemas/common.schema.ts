// Skema bersama lintas modul: bentuk error, tipe primitif, dan potongan objek yang
// muncul di lebih dari satu response. Modul tidak boleh saling impor, jadi apa pun yang
// dipakai dua modul atau lebih hidup di sini.

import { z } from '../openapi/zod.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants/limits.js';

// ---- primitif ----

export const uuidSchema = z.uuid().openapi({ example: '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21' });

/** Tanggal kalender `YYYY-MM-DD`, zona Asia/Jakarta. */
export const dateSchema = z.iso.date().openapi({ example: '2026-09-28' });

/** Timestamp ISO 8601 UTC. */
export const timestampSchema = z.iso.datetime().openapi({ example: '2026-09-28T05:12:35Z' });

/** Rupiah penuh, bilangan bulat. Tanpa desimal, tanpa string. */
export const rupiahSchema = z.int().openapi({ example: 25000 });

/** Rupiah penuh yang harus positif (nominal transaksi). */
export const positiveRupiahSchema = z.int().positive().openapi({ example: 25000 });

export const idParamsSchema = z.object({ id: uuidSchema });

/** Tipe ditentukan kolom ini, bukan tanda nominal. */
export const transactionTypeSchema = z.enum(['income', 'expense']).openapi('TransactionType');

// ---- error ----

export const errorDetailSchema = z
  .object({
    field: z.string().optional().openapi({ example: 'amount' }),
    issue: z.string().openapi({ example: 'must_be_positive' }),
    attempts_left: z.int().optional().openapi({ description: 'Hanya pada verifikasi OTP yang salah.' }),
    retry_after_seconds: z.int().optional().openapi({ description: 'Hanya pada RATE_LIMITED.' }),
  })
  .openapi('ErrorDetail');

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'Nominal harus lebih besar dari 0' }),
      details: z.array(errorDetailSchema).optional(),
    }),
  })
  .openapi('ErrorResponse');

// ---- potongan objek yang dipakai bersama ----

export const categorySummarySchema = z
  .object({
    id: uuidSchema,
    name: z.string().openapi({ example: 'Makanan' }),
    icon: z.string().openapi({ example: 'utensils' }),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).openapi({ example: '#FF7F6B' }),
  })
  .openapi('CategorySummary');

export const accountSummarySchema = z
  .object({
    id: uuidSchema,
    name: z.string().openapi({ example: 'Tunai' }),
  })
  .openapi('AccountSummary');

// ---- paginasi cursor ----

export const paginationQuerySchema = z.object({
  cursor: z
    .string()
    .max(200)
    .optional()
    .openapi({ description: '`next_cursor` dari halaman sebelumnya. Opak; jangan di-parse klien.' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    // `coerce` membuat tipe input tak terbaca generator, jadi batasnya ditulis ulang di sini.
    .openapi({
      type: 'integer',
      minimum: 1,
      maximum: PAGE_SIZE_MAX,
      default: PAGE_SIZE_DEFAULT,
      example: PAGE_SIZE_DEFAULT,
    }),
});

export function paginatedSchema<T extends z.ZodType>(item: T, name: string) {
  return z
    .object({
      data: z.array(item),
      next_cursor: z
        .string()
        .nullable()
        .openapi({ description: 'Null bila tidak ada halaman berikutnya.' }),
      has_more: z.boolean(),
    })
    .openapi(name);
}

// ---- respons sederhana ----

export const messageResponseSchema = z
  .object({ message: z.string().openapi({ example: 'Jika email terdaftar, tautan reset telah dikirim.' }) })
  .openapi('MessageResponse');
