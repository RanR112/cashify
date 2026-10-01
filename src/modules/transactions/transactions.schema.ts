import { z } from '../../shared/openapi/zod.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TRANSACTION_AMOUNT } from '../../shared/constants/limits.js';
import { oneYearBefore, todayInJakarta } from '../../shared/utils/timezone.js';
import {
  accountSummarySchema,
  categorySummarySchema,
  dateSchema,
  paginatedSchema,
  paginationQuerySchema,
  positiveRupiahSchema,
  timestampSchema,
  transactionTypeSchema,
  uuidSchema,
} from '../../shared/schemas/common.schema.js';

export const transactionSourceSchema = z
  .enum(['manual', 'whatsapp', 'recurring', 'import'])
  .openapi('TransactionSource');

// ---- request ----

const amountInputSchema = positiveRupiahSchema.max(MAX_TRANSACTION_AMOUNT).openapi({
  description: `Rupiah penuh, bilangan bulat positif, maksimal ${MAX_TRANSACTION_AMOUNT}.`,
});

/** Tidak boleh di masa depan atau lebih dari satu tahun ke belakang (zona Asia/Jakarta). */
const transactionDateInputSchema = dateSchema
  .refine((value) => value <= todayInJakarta(), { message: 'Tanggal tidak boleh di masa depan' })
  .refine((value) => value >= oneYearBefore(todayInJakarta()), {
    message: 'Tanggal tidak boleh lebih dari satu tahun ke belakang',
  })
  .openapi({ description: 'Tidak boleh di masa depan atau lebih dari satu tahun ke belakang.' });

const descriptionInputSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_LENGTH)
  .openapi({ example: 'makan siang' });

export const createTransactionBodySchema = z
  .object({
    type: transactionTypeSchema,
    amount: amountInputSchema,
    category_id: uuidSchema.openapi({
      description: 'Harus ada, bertipe sama dengan `type`, milik pengguna atau kategori sistem.',
    }),
    account_id: uuidSchema.openapi({ description: 'Dompet milik pengguna.' }),
    date: transactionDateInputSchema,
    description: descriptionInputSchema.nullish(),
  })
  .openapi('CreateTransactionBody');

export const updateTransactionBodySchema = z
  .object({
    updated_at: timestampSchema.openapi({
      description:
        '`updated_at` yang terakhir dibaca klien (optimistic locking). Bila sudah berubah, server membalas 409 dan klien harus memuat ulang.',
    }),
    type: transactionTypeSchema.optional(),
    amount: amountInputSchema.optional(),
    category_id: uuidSchema.optional(),
    account_id: uuidSchema.optional(),
    date: transactionDateInputSchema.optional(),
    description: descriptionInputSchema.nullish().openapi({ description: 'Null mengosongkan deskripsi.' }),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'updated_at'), {
    message: 'Minimal satu field selain updated_at harus diisi',
  })
  .openapi('UpdateTransactionBody', {
    description: '`updated_at` wajib; minimal satu field lain harus diisi.',
  });

export const listTransactionsQuerySchema = paginationQuerySchema
  .extend({
    from: dateSchema.optional().openapi({ description: 'Tanggal awal, inklusif.' }),
    to: dateSchema.optional().openapi({ description: 'Tanggal akhir, inklusif.' }),
    type: transactionTypeSchema.optional(),
    category_id: uuidSchema.optional(),
    account_id: uuidSchema.optional(),
    source: transactionSourceSchema.optional(),
    q: z.string().trim().min(1).max(100).optional().openapi({
      description: 'Pencarian teks pada deskripsi.',
      example: 'makan',
    }),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '`from` tidak boleh setelah `to`',
  });

/** Isi cursor daftar: posisi baris terakhir pada urutan (date DESC, id DESC). Opak bagi klien. */
export const cursorPayloadSchema = z.object({ d: dateSchema, i: uuidSchema });

// ---- response ----

export const transactionSchema = z
  .object({
    id: uuidSchema,
    type: transactionTypeSchema,
    amount: positiveRupiahSchema,
    date: dateSchema,
    description: z.string().nullable().openapi({ example: 'makan siang' }),
    source: transactionSourceSchema,
    category: categorySummarySchema,
    account: accountSummarySchema,
    created_at: timestampSchema,
    updated_at: timestampSchema.openapi({ description: 'Kirim kembali pada PATCH sebagai penjaga konflik.' }),
  })
  .openapi('Transaction');

export const sourceMessageSchema = z
  .object({
    body: z.string().nullable().openapi({ example: 'tadi makan siang 25 ribu' }),
    received_at: timestampSchema,
  })
  .openapi('SourceMessage');

export const transactionDetailSchema = transactionSchema
  .extend({
    source_message: sourceMessageSchema
      .nullable()
      .openapi({ description: 'Pesan WhatsApp asal; null bila transaksi tidak berasal dari WhatsApp.' }),
  })
  .openapi('TransactionDetail');

export const transactionListSchema = paginatedSchema(transactionSchema, 'TransactionList');
