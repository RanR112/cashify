import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  REDIS_URL: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  OPENWA_URL: z.string().url(),
  OPENWA_API_KEY: z.string().min(1),
  // Nilai flag --session-id OpenWA; dipakai untuk mencatat status bot di whatsapp_sessions.
  OPENWA_SESSION_ID: z.string().min(1).default('myfinance-bot'),
  // OpenWA v4 tidak bisa mengirim header kustom, jadi rahasia ini menjadi segmen path webhook
  // (/webhooks/openwa/<WEBHOOK_SECRET>) dan harus aman dipakai di URL.
  WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,}$/, 'minimal 16 karakter huruf, angka, "-" atau "_" (buat dengan: openssl rand -hex 24)'),

  LLM_PROVIDER: z.enum(['disabled']).default('disabled'),
  LLM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`Konfigurasi lingkungan tidak valid, aplikasi berhenti:\n${problems}`);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
