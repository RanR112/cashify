import { z } from '../../shared/openapi/zod.js';
import { dateSchema, rupiahSchema, transactionTypeSchema, uuidSchema } from '../../shared/schemas/common.schema.js';

/** Bulan kalender `YYYY-MM` dengan bulan 01-12. */
export const reportMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format harus YYYY-MM')
  .openapi({ example: '2026-10' });

// ---- request ----

export const monthlyReportQuerySchema = z.object({
  month: reportMonthSchema.optional().openapi({
    description: 'Bulan yang dilaporkan. Default: bulan berjalan (Asia/Jakarta).',
  }),
});

export const trendReportQuerySchema = z.object({
  months: z.coerce
    .number()
    .int()
    .min(1)
    .max(12)
    .default(6)
    // `coerce` membuat tipe input tak terbaca generator, jadi batasnya ditulis ulang di sini.
    .openapi({
      type: 'integer',
      minimum: 1,
      maximum: 12,
      default: 6,
      example: 6,
      description: 'Jumlah bulan terakhir yang dilaporkan, termasuk bulan berjalan.',
    }),
});

// ---- response ----

/** Persen satu desimal; jumlah seluruh kategori satu tipe boleh 99,9-100,1 karena pembulatan. */
const percentSchema = z.number().min(0).openapi({
  example: 45.3,
  description:
    'Persentase terhadap total tipe yang sama (pemasukan atau pengeluaran), satu desimal. ' +
    'Jumlah persen per tipe boleh 99,9-100,1 karena pembulatan.',
});

export const reportCategorySchema = z
  .object({
    category_id: uuidSchema,
    name: z.string().openapi({ example: 'Makanan' }),
    slug: z.string().openapi({ example: 'food' }),
    type: transactionTypeSchema,
    total: rupiahSchema,
    percent: percentSchema,
  })
  .openapi('ReportCategory');

export const reportDailySchema = z
  .object({
    date: dateSchema,
    income: rupiahSchema,
    expense: rupiahSchema,
  })
  .openapi('ReportDaily');

export const monthlyReportSchema = z
  .object({
    month: reportMonthSchema,
    income_total: rupiahSchema.openapi({ description: 'Total pemasukan bulan itu.' }),
    expense_total: rupiahSchema.openapi({ description: 'Total pengeluaran bulan itu.' }),
    net: rupiahSchema.openapi({ description: '`income_total - expense_total`; bisa negatif.' }),
    by_category: z
      .array(reportCategorySchema)
      .openapi({ description: 'Kategori yang punya transaksi, diurutkan total menurun.' }),
    daily: z
      .array(reportDailySchema)
      .openapi({ description: 'Setiap tanggal dalam bulan itu; hari tanpa transaksi bernilai 0.' }),
  })
  .openapi('MonthlyReport');

export const trendReportSchema = z
  .object({
    months: z
      .array(
        z.object({
          month: reportMonthSchema,
          income: rupiahSchema,
          expense: rupiahSchema,
          net: rupiahSchema,
        }),
      )
      .openapi({ description: 'Urut menaik; bulan tanpa transaksi tetap ada dengan nilai 0.' }),
  })
  .openapi('TrendReport');
