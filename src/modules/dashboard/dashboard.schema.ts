// Dashboard adalah satu-satunya modul yang boleh mengimpor modul lain (agregator).
// Bentuk respons: claude/ARCHITECTURE.md Bagian 12, tanpa `budget_summary`
// karena anggaran di luar cakupan (LOCAL-MODE.md). Menambah field nanti tidak merusak klien.

import { z } from '../../shared/openapi/zod.js';
import { dateSchema, rupiahSchema } from '../../shared/schemas/common.schema.js';
import { transactionSchema } from '../transactions/transactions.schema.js';

export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format harus YYYY-MM')
  .openapi({ example: '2026-09' });

export const dashboardQuerySchema = z.object({
  month: monthSchema.optional().openapi({ description: 'Bulan yang diringkas. Default: bulan berjalan (Asia/Jakarta).' }),
});

export const dashboardResponseSchema = z
  .object({
    balance: rupiahSchema.openapi({
      example: 2350000,
      description: '`initial_balance` + total pemasukan − total pengeluaran, seluruh waktu. Dihitung, tidak disimpan; bisa negatif.',
    }),
    month: z.object({
      income: rupiahSchema.openapi({ example: 5000000 }),
      expense: rupiahSchema.openapi({ example: 2650000 }),
      net: rupiahSchema.openapi({ example: 2350000, description: 'income − expense; bisa negatif.' }),
    }),
    cashflow: z
      .array(z.object({ date: dateSchema, income: rupiahSchema, expense: rupiahSchema }))
      .openapi({ description: 'Satu entri per hari yang punya transaksi, naik menurut tanggal.' }),
    recent_transactions: z
      .array(transactionSchema)
      .max(10)
      .openapi({ description: 'Hingga 10 transaksi terbaru, terlepas dari bulan yang dipilih.' }),
  })
  .openapi('Dashboard');
