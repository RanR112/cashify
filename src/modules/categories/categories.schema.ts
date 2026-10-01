import { z } from '../../shared/openapi/zod.js';
import { categorySummarySchema, transactionTypeSchema } from '../../shared/schemas/common.schema.js';

export const listCategoriesQuerySchema = z.object({
  type: transactionTypeSchema.optional().openapi({ description: 'Saring menurut tipe.' }),
});

export const categorySchema = categorySummarySchema
  .extend({
    type: transactionTypeSchema,
    is_system: z.boolean().openapi({ description: 'True untuk kategori bawaan sistem (tidak bisa diubah).' }),
  })
  .openapi('Category');

export const listCategoriesResponseSchema = z
  .object({ data: z.array(categorySchema) })
  .openapi('CategoryList');
