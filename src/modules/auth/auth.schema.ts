import { z } from '../../shared/openapi/zod.js';
import { MAX_INT32 } from '../../shared/constants/limits.js';

// Supabase Auth membatasi password hingga 72 byte (batas bcrypt).
const passwordSchema = z.string().min(8, 'Password minimal 8 karakter').max(72);

export const registerBodySchema = z
  .object({
    email: z.email().openapi({ example: 'dey@example.com' }),
    password: passwordSchema.openapi({
      example: 'rahasia-banget-123',
      description: 'Minimal 8 karakter, maksimal 72. Pemeriksaan password bocor hanya jika diaktifkan di Supabase (bukan free tier).',
    }),
    full_name: z.string().trim().min(2).max(100).openapi({ example: 'Dey' }),
    initial_balance: z
      .int()
      .min(0)
      .max(MAX_INT32)
      .default(0)
      .openapi({ example: 2350000, description: 'Saldo awal dalam rupiah penuh, bilangan bulat ≥ 0.' }),
  })
  .openapi('RegisterBody');

export const loginBodySchema = z
  .object({
    email: z.email().openapi({ example: 'dey@example.com' }),
    password: z.string().min(1).openapi({ example: 'rahasia-banget-123' }),
  })
  .openapi('LoginBody');

export const googleBodySchema = z
  .object({
    id_token: z.string().min(1).max(8192).openapi({
      description: 'ID token Google dari Google Sign-In native di klien. Diteruskan ke Supabase, yang memverifikasinya ke Google.',
      example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ij...',
    }),
  })
  .openapi('GoogleBody');

export const refreshBodySchema = z
  .object({ refresh_token: z.string().min(1) })
  .openapi('RefreshBody');

export const forgotPasswordBodySchema = z
  .object({ email: z.email().openapi({ example: 'dey@example.com' }) })
  .openapi('ForgotPasswordBody');

export const resetPasswordBodySchema = z
  .object({
    token: z.string().min(1).openapi({
      description: 'Token pemulihan dari tautan di email reset (parameter `access_token` pada URL redirect Supabase).',
    }),
    password: passwordSchema.openapi({ example: 'password-baru-456' }),
  })
  .openapi('ResetPasswordBody');
