import { z } from '../../shared/openapi/zod.js';
import { MAX_INT32 } from '../../shared/constants/limits.js';
import {
  dateSchema,
  positiveRupiahSchema,
  rupiahSchema,
  timestampSchema,
  uuidSchema,
} from '../../shared/schemas/common.schema.js';

export const budgetPeriodTypeSchema = z.enum(['monthly', 'weekly']).openapi('BudgetPeriodType');

export const budgetStatusSchema = z.enum(['ok', 'warning', 'over']).openapi('BudgetStatus');

// ---- request ----

const categoryAllocationFields = {
  category_id: uuidSchema,
  amount: positiveRupiahSchema.max(MAX_INT32),
  alert_threshold: z.int().min(1).max(100).openapi({
    example: 80,
    description: 'Ambang peringatan dalam persen, 1-100. Bawaan 80 untuk alokasi baru.',
  }),
};

const createCategoryAllocationSchema = z.object({
  ...categoryAllocationFields,
  alert_threshold: categoryAllocationFields.alert_threshold.default(80),
});

/** `alert_threshold` opsional: bila tidak dikirim, nilai lama dipertahankan (baris baru: 80). */
const updateCategoryAllocationSchema = z.object({
  ...categoryAllocationFields,
  alert_threshold: categoryAllocationFields.alert_threshold.optional(),
});

function hasDuplicateCategoryIds(categories: { category_id: string }[]): boolean {
  return new Set(categories.map((category) => category.category_id)).size !== categories.length;
}

export const createBudgetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional().openapi({
      example: 'Anggaran Oktober',
      description: 'Opsional, maksimal 100 karakter.',
    }),
    period_type: budgetPeriodTypeSchema,
    period_start: dateSchema.openapi({
      example: '2026-10-01',
      description: 'Dinormalkan server ke awal periode: tanggal 1 (monthly) atau Senin (weekly).',
    }),
    total_amount: positiveRupiahSchema.max(MAX_INT32).openapi({
      example: 3000000,
      description: 'Batas seluruh pengeluaran periode, rupiah penuh.',
    }),
    auto_renew: z.boolean().default(true).openapi({ description: 'Disimpan; perpanjangan otomatis belum dijalankan.' }),
    rollover_enabled: z.boolean().default(false).openapi({
      description: 'Disimpan tanpa efek; rollover belum diimplementasikan.',
    }),
    categories: z.array(createCategoryAllocationSchema).min(1).openapi({
      description: 'Minimal satu kategori pengeluaran; jumlah amount tidak boleh melebihi total_amount.',
    }),
  })
  .superRefine((value, ctx) => {
    if (hasDuplicateCategoryIds(value.categories)) {
      ctx.addIssue({ code: 'custom', path: ['categories'], message: 'Kategori tidak boleh ganda' });
    }
    const allocated = value.categories.reduce((sum, category) => sum + category.amount, 0);
    if (allocated > value.total_amount) {
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'Jumlah alokasi kategori melebihi total anggaran',
      });
    }
  });

/**
 * Body PATCH. `passthrough` dipakai agar field periode yang terlarang tetap terlihat oleh
 * `superRefine` (Zod membuang kunci tak dikenal pada object biasa), sehingga dapat dijawab 400.
 * Field tak dikenal lain tetap diabaikan seperti endpoint lain.
 */
export const updateBudgetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    total_amount: positiveRupiahSchema.max(MAX_INT32).optional(),
    auto_renew: z.boolean().optional(),
    rollover_enabled: z.boolean().optional(),
    categories: z.array(updateCategoryAllocationSchema).min(1).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const field of ['period_type', 'period_start', 'period_end'] as const) {
      if (field in value) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'Tidak boleh diubah' });
      }
    }
    if (
      value.name === undefined &&
      value.total_amount === undefined &&
      value.auto_renew === undefined &&
      value.rollover_enabled === undefined &&
      value.categories === undefined
    ) {
      ctx.addIssue({ code: 'custom', message: 'Minimal satu field harus diisi' });
    }
    if (value.categories && hasDuplicateCategoryIds(value.categories)) {
      ctx.addIssue({ code: 'custom', path: ['categories'], message: 'Kategori tidak boleh ganda' });
    }
  });

export const budgetListQuerySchema = z.object({
  status: z.enum(['active', 'all']).default('all').openapi({
    example: 'all',
    description: '`active` = periode memuat hari ini (Asia/Jakarta). Bawaan `all` agar riwayat tidak hilang.',
  }),
});

// ---- response ----

/** Persen satu desimal; boleh melewati 100 karena pemakaian bisa melampaui anggaran. */
const percentSchema = z.number().min(0).openapi({
  example: 88.3,
  description: 'Satu desimal. Pembagian dengan nol menghasilkan 0.',
});

export const budgetCategorySchema = z
  .object({
    category_id: uuidSchema,
    name: z.string().openapi({ example: 'Makanan' }),
    slug: z.string().openapi({ example: 'food' }),
    amount: positiveRupiahSchema,
    alert_threshold: z.int().min(1).max(100).openapi({ example: 80 }),
  })
  .openapi('BudgetCategory');

const budgetFields = {
  id: uuidSchema,
  name: z.string().nullable().openapi({ example: 'Anggaran Oktober' }),
  period_type: budgetPeriodTypeSchema,
  period_start: dateSchema,
  period_end: dateSchema,
  total_amount: positiveRupiahSchema,
  auto_renew: z.boolean(),
  rollover_enabled: z.boolean(),
  created_at: timestampSchema,
};

export const budgetSchema = z
  .object({
    ...budgetFields,
    categories: z.array(budgetCategorySchema),
  })
  .openapi('Budget');

export const budgetCategoryProgressSchema = budgetCategorySchema
  .extend({
    spent: rupiahSchema.openapi({ description: 'Pengeluaran kategori ini dalam periode.' }),
    remaining: rupiahSchema.openapi({ description: '`amount - spent`; bisa negatif.' }),
    percent: percentSchema,
    status: budgetStatusSchema,
  })
  .openapi('BudgetCategoryProgress');

export const budgetDetailSchema = z
  .object({
    ...budgetFields,
    categories: z.array(budgetCategoryProgressSchema),
    spent_total: rupiahSchema.openapi({ description: 'Seluruh pengeluaran periode, termasuk kategori tak teralokasi.' }),
    remaining_total: rupiahSchema.openapi({ description: '`total_amount - spent_total`; bisa negatif.' }),
    percent_total: percentSchema,
    status_total: budgetStatusSchema.openapi({ description: 'Ambang total 80%.' }),
  })
  .openapi('BudgetDetail');

export const budgetListSchema = z
  .object({
    data: z.array(budgetSchema),
  })
  .openapi('BudgetList');

export const budgetSummarySchema = z
  .object({
    budget_id: uuidSchema,
    name: z.string().nullable(),
    period_start: dateSchema,
    period_end: dateSchema,
    total: positiveRupiahSchema,
    used: rupiahSchema.openapi({ description: 'Seluruh pengeluaran periode.' }),
    remaining: rupiahSchema.openapi({ description: '`total - used`; bisa negatif.' }),
    percent: percentSchema,
    status: budgetStatusSchema,
  })
  .openapi('BudgetSummary');
