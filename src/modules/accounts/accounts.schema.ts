import { z } from '../../shared/openapi/zod.js';
import { accountSummarySchema } from '../../shared/schemas/common.schema.js';

export const accountSchema = accountSummarySchema
  .extend({
    type: z.enum(['cash', 'bank', 'ewallet']).openapi({ example: 'cash' }),
    is_default: z.boolean(),
  })
  .openapi('Account');

export const listAccountsResponseSchema = z
  .object({ data: z.array(accountSchema) })
  .openapi('AccountList');
