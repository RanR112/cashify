// Batas ke LLM (aturan 2 dan 3). LLM hanya menerima teks pesan dan hanya boleh mengembalikan
// klasifikasi intent/tipe/kategori. Kontraknya SECARA STRUKTURAL tidak punya field `amount`
// maupun `date`: skema bersifat strict, jadi keluaran yang membawa salah satunya dibuang utuh.
// Nominal dan tanggal selalu dari regex di src/parsers/; balasan ke pengguna selalu dirakit dari
// template di kode, tidak pernah dari teks LLM.
//
// Implementasi default adalah DisabledLlmGateway (LOCAL-MODE.md): semua layanan harus gratis.

import { z } from 'zod';

/** Di bawah ini, keluaran LLM tidak dipakai dan pipeline bertanya ke pengguna. */
export const LLM_CONFIDENCE_THRESHOLD = 0.7;

/** Lewat batas ini pipeline jalan terus tanpa LLM dan menanyakan kategori. */
export const LLM_TIMEOUT_MS = 3_000;

export const LlmClassificationSchema = z.strictObject({
  intent: z.enum([
    'CREATE_TRANSACTION',
    'CONFIRM',
    'CANCEL',
    'CLARIFY_RESPONSE',
    'QUERY',
    'CORRECT',
    'DELETE',
    'HELP',
    'UNKNOWN',
  ]),
  type: z.enum(['income', 'expense']),
  category_hint: z.string().max(64),
  description: z.string().max(255),
  confidence: z.number().min(0).max(1),
});

export type LlmClassification = z.infer<typeof LlmClassificationSchema>;

export interface LlmGateway {
  /**
   * Mengklasifikasikan teks pesan. Mengembalikan keluaran MENTAH penyedia (`unknown`): tidak ada
   * yang boleh mempercayainya sebelum lewat `safeClassify`. Boleh melempar.
   */
  classify(text: string): Promise<unknown>;
}

/** Validasi Zod. Gagal berarti dibuang (null), bukan diperbaiki. */
export function parseLlmOutput(raw: unknown): LlmClassification | null {
  const parsed = LlmClassificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Satu-satunya jalan memakai LLM. Mengembalikan klasifikasi yang layak dipakai, atau `null` yang
 * berarti "jatuh ke perilaku aman: tanya pengguna". Itu terjadi bila LLM melempar, melewati
 * timeout, keluarannya gagal skema (termasuk membawa `amount`/`date`), atau confidence di
 * bawah ambang.
 */
export async function safeClassify(
  gateway: LlmGateway,
  text: string,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<LlmClassification | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const raw = await Promise.race([gateway.classify(text), timeout]);
    if (raw === null) return null;
    const result = parseLlmOutput(raw);
    return result && result.confidence >= LLM_CONFIDENCE_THRESHOLD ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
