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

  AUTH_RESET_REDIRECT_URL: z.url().optional(),

  OPENWA_URL: z.string().url(),
  OPENWA_API_KEY: z.string().min(1),
  // Nilai flag --session-id OpenWA; dipakai untuk mencatat status bot di whatsapp_sessions.
  OPENWA_SESSION_ID: z.string().min(1).default('myfinance-bot'),
  // OpenWA v4 tidak bisa mengirim header kustom, jadi rahasia ini menjadi segmen path webhook
  // (/webhooks/openwa/<WEBHOOK_SECRET>) dan harus aman dipakai di URL.
  WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,}$/, 'minimal 16 karakter huruf, angka, "-" atau "_" (buat dengan: openssl rand -hex 24)'),

  // LLM sebagai cadangan klasifikasi kategori/intent (ARCHITECTURE.md Bagian 7 tahap 5), dijalankan
  // hanya oleh worker. `disabled` berarti tanpa jaringan sama sekali (LOCAL-MODE.md). Menambah
  // penyedia lain cukup menambah nilainya di enum ini dan satu gateway.
  LLM_PROVIDER: z.enum(['disabled', 'groq']).default('disabled'),
  LLM_API_KEY: z.string().optional(),
  /** Kosong berarti bawaan penyedia (Groq: https://api.groq.com/openai/v1). */
  LLM_BASE_URL: z.url().optional(),
  /** Kosong berarti bawaan penyedia. Lihat SYSTEM_DOCUMENTATION.md bagian 10.5. */
  LLM_MODEL: z.string().min(1).optional(),
  /**
   * `template` (bawaan): LLM hanya mengklasifikasi; semua teks balasan dari whatsapp.templates.ts.
   * `freeform`: LLM menjawab bebas untuk pesan yang tidak bisa diproses deterministik. Mode ini
   * menyimpang dari aturan proyek 3 dan karena itu opt-in (SYSTEM_DOCUMENTATION.md 10.5).
   */
  LLM_REPLY_MODE: z.enum(['template', 'freeform']).default('template'),
})
  .superRefine((value, ctx) => {
    // `LLM_PROVIDER` selain `disabled` tanpa kunci hanya akan gagal saat pesan pertama masuk;
    // lebih baik gagal saat start. String kosong (`LLM_API_KEY=`) dianggap belum diisi.
    if (value.LLM_PROVIDER !== 'disabled' && !value.LLM_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_API_KEY'],
        message: 'wajib diisi bila LLM_PROVIDER bukan "disabled"',
      });
    }
    // Tanpa gateway, mode freeform tidak akan pernah punya jawaban; jangan biarkan salah
    // konfigurasi tampak seperti "LLM-nya jelek".
    if (value.LLM_REPLY_MODE === 'freeform' && value.LLM_PROVIDER === 'disabled') {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_REPLY_MODE'],
        message: 'freeform membutuhkan LLM_PROVIDER selain "disabled"',
      });
    }
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
