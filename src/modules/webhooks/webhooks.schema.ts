// Kontrak webhook OpenWA v4.76.0, dari rekaman nyata spike P0 (bukan dokumentasi openwa.dev,
// yang memakai bentuk v5). Yang tervalidasi hanya field yang dipakai kode ini; sisanya
// (sekitar 100 field per pesan) lolos apa adanya dan tersimpan di `raw_payload`.
//
// Yang direkam: `onMessage`, `onAnyMessage`, `onAck`. Satu pesan masuk datang dua kali
// (`onMessage` + `onAnyMessage`); pesan grup datang dulu sebagai `type: "ciphertext"` lalu
// `type: "chat"` dengan `data.id` yang sama.

import { z } from '../../shared/openapi/zod.js';

export const webhookParamsSchema = z.object({
  path: z.string().min(1).max(128).openapi({
    description:
      'Rahasia webhook (`WEBHOOK_SECRET`). OpenWA v4 tidak bisa mengirim header kustom, jadi rahasia ada di path ' +
      'dan dibandingkan dengan `crypto.timingSafeEqual`.',
    example: 'a7f2k9m3q1b8x5c4v6n2d0e1f3g7h9j2',
  }),
});

/**
 * Amplop yang dibungkus OpenWA di sekitar setiap event. `data` sengaja tidak diperiksa di sini:
 * bentuknya berbeda per event (`onAck`, `onStateChanged`, ...), dan event yang tidak diproses
 * tidak boleh ditolak hanya karena `data`-nya asing.
 */
export const webhookEnvelopeSchema = z
  .looseObject({
    event: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    id: z.string().min(1).max(64).optional(),
    ts: z.number().optional(),
    webhook_id: z.string().optional(),
    data: z.unknown(),
  })
  .openapi('OpenWaWebhookBody', {
    description:
      'Event OpenWA v4.76.0, amplop `{ ts, sessionId, id, event, data, webhook_id }`. Hanya `onMessage` yang diproses; ' +
      '`onAnyMessage`, `onAck`, dan event lain dibalas 204 tanpa efek. Server menyimpan body mentah sebagai string ' +
      'sebelum parsing.',
  });

/** `data` milik event `onMessage`. */
export const inboundMessageSchema = z.looseObject({
  /** Kunci idempotency: `false_<chat>_<mId>` untuk chat pribadi, ditambah `_<pengirim>` untuk grup. */
  id: z.string().min(1).max(128),
  /** Chat pribadi memakai LID (`...@lid`), bukan nomor; nomor ada di `sender.phoneNumber`. Grup: `...@g.us`. */
  chatId: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  fromMe: z.boolean(),
  isGroupMsg: z.boolean().default(false),
  /** Teks untuk `chat`; untuk media berisi thumbnail base64 (bukan teks). */
  body: z.string().nullish(),
  caption: z.string().nullish(),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;
