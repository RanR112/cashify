// Implementasi LlmGateway untuk penyedia yang kompatibel dengan OpenAI Chat Completions. Yang
// dipakai proyek ini: Groq (https://api.groq.com/openai/v1). Satu-satunya berkas yang tahu bentuk
// HTTP penyedia.
//
// Yang dikirim ke penyedia HANYA teks pesan, dipotong LLM_MAX_INPUT_CHARS (Bagian 18: tanpa
// `user_id`, tanpa nomor telepon, tanpa riwayat transaksi). `classify` mengembalikan objek MENTAH
// hasil `JSON.parse` dan `chat` mengembalikan teks MENTAH; validasi skema, ambang confidence,
// sanitasi, dan timeout tetap di `safeClassify`/`safeChat`, jadi berkas ini boleh melempar
// sebebasnya.

import { z } from 'zod';
import {
  LLM_CHAT_MAX_TOKENS,
  LLM_MAX_INPUT_CHARS,
  LlmRequestError,
  type LlmGateway,
} from './llm.gateway.js';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Model bawaan. Tugasnya hanya klasifikasi, jadi model kecil sudah memadai (Bagian 7). */
export const LLM_DEFAULT_MODEL = 'qwen/qwen3.8-27b';

/**
 * Jaringan ke penyedia. Lebih panjang dari batas `safeClassify` (3 detik) karena `safeClassify`
 * yang memutuskan lebih dulu; ini hanya jaring agar request benar-benar dibatalkan.
 */
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 300;

/**
 * Instruksi sistem. Sengaja menyebut lima field yang diizinkan dan menutup `amount`/`date` secara
 * eksplisit: apa pun yang lolos tetap dibuang `LlmClassificationSchema` yang strict.
 */
export const LLM_SYSTEM_PROMPT = [
  'Kamu pengklasifikasi pesan WhatsApp untuk aplikasi keuangan pribadi berbahasa Indonesia.',
  'Balas HANYA satu objek JSON dengan tepat lima field: intent, type, category_hint, description, confidence.',
  'intent: salah satu dari CREATE_TRANSACTION, CONFIRM, CANCEL, CLARIFY_RESPONSE, QUERY, CORRECT, DELETE, HELP, UNKNOWN.',
  'type: "income" atau "expense".',
  'category_hint: satu kata kategori berbahasa Indonesia (mis. makanan, transportasi, belanja, tagihan, kesehatan, hiburan, gaji, bonus); string kosong bila tidak yakin.',
  'description: ringkasan singkat isi pesan, tanpa nominal.',
  'confidence: angka 0 sampai 1 tanpa tanda kutip.',
  'JANGAN menyertakan field amount, date, nominal, atau tanggal: keduanya ditentukan di luar kamu.',
].join(' ');

/**
 * Instruksi sistem untuk jawaban bebas (`LLM_REPLY_MODE=freeform`). LLM tidak diberi akses data
 * pengguna; larangan menyebut nominal dan mengaku mencatat transaksi adalah lapis pertama, dan
 * `sanitizeChatReply` menjadi lapis terakhir.
 */
export const LLM_CHAT_SYSTEM_PROMPT = [
  'Kamu asisten WhatsApp Cashify, aplikasi keuangan pribadi berbahasa Indonesia.',
  'Jawab ringkas, ramah, maksimal empat kalimat, tanpa tabel dan tanpa markdown berlebihan.',
  'Kamu TIDAK dapat melihat saldo, transaksi, anggaran, atau data pengguna lain.',
  'Jangan pernah menyebut nominal uang, saldo, atau tanggal transaksi. Bila ditanya, arahkan pengguna membuka aplikasi Cashify.',
  'Jangan mengaku sudah mencatat, mengubah, atau menghapus transaksi. Pencatatan hanya lewat alur konfirmasi: pengguna menulis transaksi, bot menampilkan ringkasan, lalu pengguna membalas YA.',
  'Bila pengguna ingin mencatat transaksi, minta menuliskannya dalam satu pesan, misalnya "makan siang dua puluh lima ribu".',
  'Jangan menyebut dirimu model bahasa atau nama penyedia; cukup "asisten Cashify".',
].join(' ');

/** Hanya amplop respons yang perlu dibaca; sisa field penyedia dibiarkan. */
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export interface GroqGatewayOptions {
  apiKey: string;
  /** Bawaan GROQ_BASE_URL; diisi bila memakai penyedia lain yang kompatibel OpenAI. */
  baseUrl?: string;
  /** Bawaan LLM_DEFAULT_MODEL. */
  model?: string;
  timeoutMs?: number;
  /** Disuntik di test; bawaannya fetch global Node. */
  fetch?: typeof fetch;
}

export function createGroqLlmGateway(options: GroqGatewayOptions): LlmGateway {
  const base = (options.baseUrl ?? GROQ_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? LLM_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  return {
    async classify(text: string): Promise<unknown> {
      const res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Mode JSON penyedia; jaminan bentuk tetap dari LlmClassificationSchema.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: text.slice(0, LLM_MAX_INPUT_CHARS) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new LlmRequestError(res.status);
      const parsed = completionSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error('LLM membalas bentuk yang tidak dikenal');
      // Konten bisa saja bukan JSON (mis. dibungkus pagar kode); JSON.parse melempar dan
      // `safeClassify` menjatuhkannya ke perilaku aman.
      return JSON.parse(parsed.data.choices[0]!.message.content);
    },

    async chat(text: string): Promise<string> {
      const res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model,
          // Sedikit lebih tinggi dari klasifikasi: jawaban bebas tidak boleh kaku, tetapi tetap
          // tidak kreatif. Suhu rendah juga membuat balasan lebih konsisten antar pesan.
          temperature: 0.3,
          max_tokens: LLM_CHAT_MAX_TOKENS,
          messages: [
            { role: 'system', content: LLM_CHAT_SYSTEM_PROMPT },
            { role: 'user', content: text.slice(0, LLM_MAX_INPUT_CHARS) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new LlmRequestError(res.status);
      const parsed = completionSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error('LLM membalas bentuk yang tidak dikenal');
      // Teks MENTAH; sanitasi, batas panjang, dan guard uang ada di `safeChat`.
      return parsed.data.choices[0]!.message.content;
    },
  };
}
