// Batas ke LLM (aturan 2 dan 3). Dua jalur yang sengaja dipisah:
//
//   1. `classify` + `safeClassify` — klasifikasi intent/tipe/kategori. Kontraknya SECARA STRUKTURAL
//      tidak punya field `amount` maupun `date`: skema bersifat strict, jadi keluaran yang membawa
//      salah satunya dibuang utuh. Nominal dan tanggal selalu dari regex di src/parsers/.
//   2. `chat` + `safeChat` — jawaban bebas untuk pesan yang tidak bisa diproses deterministik.
//      Hanya dirakit bila `LLM_REPLY_MODE=freeform` (opt-in, menyimpang dari aturan 3; lihat
//      SYSTEM_DOCUMENTATION.md bagian 10.5). Keluarannya tetap disaring: batas panjang dan guard
//      uang, sehingga jawaban yang menyebut nominal dibuang dan diganti template.
//
// Implementasi default adalah DisabledLlmGateway (LOCAL-MODE.md): semua layanan harus gratis.

import { z } from 'zod';

/** Di bawah ini, keluaran LLM tidak dipakai dan pipeline bertanya ke pengguna. */
export const LLM_CONFIDENCE_THRESHOLD = 0.7;

/** Lewat batas ini pipeline jalan terus tanpa LLM dan menanyakan kategori. */
export const LLM_TIMEOUT_MS = 3_000;

/** Potong input ke LLM (Bagian 17: pesan panjang dipotong pada 500 karakter; yang penuh tetap di log). */
export const LLM_MAX_INPUT_CHARS = 500;

/** Batas jawaban bebas yang dikirim ke WhatsApp. Lebih dari ini dipotong pada batas kata. */
export const LLM_CHAT_MAX_CHARS = 600;

/** Batas token keluaran jawaban bebas; cukup untuk beberapa kalimat bahasa Indonesia. */
export const LLM_CHAT_MAX_TOKENS = 300;

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

/** Status satu panggilan LLM. Dipakai untuk log; tidak pernah memuat isi pesan atau kunci. */
export type LlmOutcome =
  | { status: 'ok' }
  | { status: 'timeout' }
  | { status: 'invalid' }
  | { status: 'low_confidence' }
  | { status: 'empty' }
  | { status: 'error'; httpStatus?: number | undefined };

export type LlmOutcomeObserver = (outcome: LlmOutcome) => void;

/** Galat HTTP penyedia, membawa status agar log bisa menyebut 401/429/5xx tanpa membaca body. */
export class LlmRequestError extends Error {
  constructor(readonly status: number) {
    super(`LLM membalas HTTP ${status}`);
    this.name = 'LlmRequestError';
  }
}

export interface LlmGateway {
  /**
   * Mengklasifikasikan teks pesan. Mengembalikan keluaran MENTAH penyedia (`unknown`): tidak ada
   * yang boleh mempercayainya sebelum lewat `safeClassify`. Boleh melempar.
   */
  classify(text: string): Promise<unknown>;

  /**
   * Jawaban bebas atas teks pesan. Hanya dipakai bila `LLM_REPLY_MODE=freeform`. Mengembalikan
   * teks MENTAH penyedia; sanitasi dan guard uang dilakukan `safeChat`. Boleh melempar.
   */
  chat?(text: string): Promise<string>;
}

/** Validasi Zod. Gagal berarti dibuang (null), bukan diperbaiki. */
export function parseLlmOutput(raw: unknown): LlmClassification | null {
  const parsed = LlmClassificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const TIMED_OUT = Symbol('llm-timeout');

/** Timer yang hasilnya bisa dibatalkan; `promise` selesai dengan penanda bila waktu habis. */
function deadline(timeoutMs: number): { promise: Promise<typeof TIMED_OUT>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function httpStatusOf(error: unknown): number | undefined {
  if (!(error instanceof LlmRequestError)) return undefined;
  return error.status;
}

function report(observer: LlmOutcomeObserver | undefined, outcome: LlmOutcome): void {
  if (!observer) return;
  try {
    observer(outcome);
  } catch {
    // Pengamat log tidak boleh menggagalkan pipeline.
  }
}

/**
 * Satu-satunya jalan memakai klasifikasi LLM. Mengembalikan klasifikasi yang layak dipakai, atau
 * `null` yang berarti "jatuh ke perilaku aman: tanya pengguna". Itu terjadi bila LLM melempar,
 * melewati timeout, keluarannya gagal skema (termasuk membawa `amount`/`date`), atau confidence di
 * bawah ambang. `onOutcome` hanya untuk observabilitas; tidak menerima teks pesan.
 */
export async function safeClassify(
  gateway: LlmGateway,
  text: string,
  timeoutMs: number = LLM_TIMEOUT_MS,
  onOutcome?: LlmOutcomeObserver,
): Promise<LlmClassification | null> {
  const timer = deadline(timeoutMs);
  try {
    const raw = await Promise.race([gateway.classify(text), timer.promise]);
    if (raw === TIMED_OUT) {
      report(onOutcome, { status: 'timeout' });
      return null;
    }
    const result = parseLlmOutput(raw);
    if (!result) {
      report(onOutcome, { status: 'invalid' });
      return null;
    }
    if (result.confidence < LLM_CONFIDENCE_THRESHOLD) {
      report(onOutcome, { status: 'low_confidence' });
      return null;
    }
    report(onOutcome, { status: 'ok' });
    return result;
  } catch (error) {
    report(onOutcome, { status: 'error', httpStatus: httpStatusOf(error) });
    return null;
  } finally {
    timer.cancel();
  }
}

/**
 * Angka yang menyerupai uang pada jawaban bebas: `25.000`, `25000`, `25 ribu`, `1,5 juta`.
 * LLM tidak punya akses database, jadi nominal apa pun di jawabannya adalah karangan. Tahun
 * (1900–2199) dikecualikan supaya jawaban biasa tidak ikut dibuang; `Rp` + angka tetap ditolak
 * lebih dulu.
 */
const MONEY_PATTERN = /\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{4,}\b|\b\d+\s*(?:ribu|rb|juta|jt|k)\b/i;
const CURRENCY_PREFIX = /\brp\.?\s*\d/i;
const YEAR_PATTERN = /\b(?:19|20|21)\d{2}\b/g;

/**
 * Membersihkan jawaban bebas sebelum dikirim ke WhatsApp. `null` berarti jawaban dibuang dan
 * pemanggil memakai template. Selain panjang dan karakter kontrol, nominal uang ikut ditolak:
 * itu pertahanan terakhir aturan 2 bila prompt sistem disusupi.
 */
export function sanitizeChatReply(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned === '') return null;
  if (CURRENCY_PREFIX.test(cleaned)) return null;
  if (MONEY_PATTERN.test(cleaned.replace(YEAR_PATTERN, ' '))) return null;

  if (cleaned.length <= LLM_CHAT_MAX_CHARS) return cleaned;
  const cut = cleaned.slice(0, LLM_CHAT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Satu-satunya jalan memakai jawaban bebas. Mengembalikan teks yang siap dikirim, atau `null`
 * yang berarti "pakai template". Berlaku bila gateway tidak punya `chat`, LLM melempar, melewati
 * timeout, jawabannya kosong, terlalu mengandung angka uang, atau tidak berbentuk teks.
 */
export async function safeChat(
  gateway: LlmGateway,
  text: string,
  timeoutMs: number = LLM_TIMEOUT_MS,
  onOutcome?: LlmOutcomeObserver,
): Promise<string | null> {
  if (!gateway.chat) {
    report(onOutcome, { status: 'error' });
    return null;
  }

  const timer = deadline(timeoutMs);
  try {
    const raw = await Promise.race([gateway.chat(text), timer.promise]);
    if (raw === TIMED_OUT) {
      report(onOutcome, { status: 'timeout' });
      return null;
    }
    if (typeof raw !== 'string') {
      report(onOutcome, { status: 'invalid' });
      return null;
    }
    if (raw.trim() === '') {
      report(onOutcome, { status: 'empty' });
      return null;
    }
    const reply = sanitizeChatReply(raw);
    report(onOutcome, reply === null ? { status: 'invalid' } : { status: 'ok' });
    return reply;
  } catch (error) {
    report(onOutcome, { status: 'error', httpStatus: httpStatusOf(error) });
    return null;
  } finally {
    timer.cancel();
  }
}
