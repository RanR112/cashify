import { z } from '../../shared/openapi/zod.js';
import { MAX_INT32 } from '../../shared/constants/limits.js';

export const updateMeBodySchema = z
  .object({
    full_name: z.string().trim().min(2).max(100).optional().openapi({ example: 'Dey Rafael' }),
    avatar_url: z.url().max(2048).nullable().optional().openapi({
      description: 'Null menghapus avatar.',
      example: 'https://example.com/avatar.png',
    }),
    initial_balance: z
      .int()
      .min(0)
      .max(MAX_INT32)
      .optional()
      .openapi({ example: 2500000, description: 'Rupiah penuh, bilangan bulat ≥ 0.' }),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Minimal satu field harus diisi' })
  .openapi('UpdateMeBody', { description: 'Minimal satu field harus diisi.' });
