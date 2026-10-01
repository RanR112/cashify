// Profil pengguna dan sesi. Dipakai `auth` (register/login) dan `users` (/me),
// jadi tidak boleh hidup di salah satu modul itu.

import { z } from '../openapi/zod.js';
import { rupiahSchema, timestampSchema, uuidSchema } from './common.schema.js';

export const userProfileSchema = z
  .object({
    id: uuidSchema,
    email: z.email().openapi({ example: 'dey@example.com' }),
    full_name: z.string().openapi({ example: 'Dey' }),
    avatar_url: z.string().nullable(),
    initial_balance: rupiahSchema.openapi({ example: 2350000 }),
    currency: z.string().length(3).openapi({ example: 'IDR' }),
    timezone: z.string().openapi({ example: 'Asia/Jakarta' }),
    locale: z.string().openapi({ example: 'id-ID' }),
    onboarding_completed_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .openapi('UserProfile');

/** Sesi dari Supabase Auth. Express tidak menerbitkan token sendiri. */
export const sessionSchema = z
  .object({
    access_token: z.string().openapi({ description: 'JWT; kirim sebagai `Authorization: Bearer`.' }),
    refresh_token: z.string(),
    token_type: z.literal('bearer'),
    expires_in: z.int().openapi({ description: 'Detik hingga access_token kedaluwarsa.', example: 3600 }),
    expires_at: z.int().openapi({ description: 'Unix timestamp (detik) kedaluwarsa.', example: 1790000000 }),
  })
  .openapi('Session');

export const authResultSchema = z
  .object({ user: userProfileSchema, session: sessionSchema })
  .openapi('AuthResult');
