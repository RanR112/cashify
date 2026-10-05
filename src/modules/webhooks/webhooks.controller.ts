// Fase sinkron webhook OpenWA. Tidak ada service (aturan 4): terima, verifikasi (di middleware),
// simpan mentah, balas 204, masukkan antrean. Semua pemrosesan pesan terjadi di worker.
//
// Yang tidak pernah dicatat ke log: isi body. `raw_payload` memuat nama dan nomor pengguna.

import type { RequestHandler } from 'express';
import { logger } from '../../config/logger.js';
import { AppError } from '../../shared/errors/AppError.js';
import {
  inboundMessageSchema,
  webhookEnvelopeSchema,
  type InboundMessage,
  type WebhookEnvelope,
} from './webhooks.schema.js';
import type { WebhookDecision, WebhooksDeps } from './webhooks.types.js';

/** Satu-satunya event yang menjadi pesan. */
export const PROCESSED_EVENT = 'onMessage';

/**
 * Event v4 yang sudah dikenal tetapi tidak diproses: tiap pesan datang juga sebagai
 * `onAnyMessage` (id sama, jadi memprosesnya menggandakan pesan), dan `onAck` hanya status kirim.
 */
const KNOWN_IGNORED_EVENTS: ReadonlySet<string> = new Set(['onAnyMessage', 'onAck']);

/**
 * Memutuskan nasib sebuah event. Fungsi murni.
 *
 * Yang diabaikan sepenuhnya (tanpa baris, tanpa job):
 * - `fromMe: true`: memproses pesan bot sendiri menciptakan lingkaran tak berujung (aturan 6).
 * - grup: bot ini hanya melayani chat pribadi.
 * - `ciphertext`: penanda sementara yang datang lebih dulu dengan `data.id` yang SAMA dengan pesan
 *   aslinya. Bila disimpan, unique index akan membuang pesan asli sebagai "kiriman ulang".
 */
export function classify(envelope: WebhookEnvelope): WebhookDecision {
  if (envelope.event !== PROCESSED_EVENT) {
    return { action: 'ignore', reason: KNOWN_IGNORED_EVENTS.has(envelope.event) ? 'event_ignored' : 'event_unknown' };
  }

  // ZodError dari sini dijawab 400 oleh errorHandler.
  const message = inboundMessageSchema.parse(envelope.data);
  if (message.fromMe) return { action: 'ignore', reason: 'from_me' };
  if (message.isGroupMsg) return { action: 'ignore', reason: 'group' };
  if (message.type === 'ciphertext') return { action: 'ignore', reason: 'ciphertext' };
  return { action: 'store', message };
}

/** Teks pesan. Untuk media, `body` OpenWA adalah thumbnail base64, jadi yang disimpan hanya keterangannya. */
function textOf(message: InboundMessage): string | null {
  return (message.type === 'chat' ? message.body : message.caption) ?? null;
}

export function createWebhooksController({ repository, enqueue }: Pick<WebhooksDeps, 'repository' | 'enqueue'>) {
  return {
    handle: (async (req, res) => {
      // 1. Body mentah sebagai string, sebelum parsing apa pun (express.text di route).
      const raw: unknown = req.body;
      if (typeof raw !== 'string') throw AppError.validation('Body kosong atau bukan teks');

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw AppError.validation('Body bukan JSON yang valid');
      }

      // 3. Bentuk amplop; ZodError dijawab 400.
      const envelope = webhookEnvelopeSchema.parse(json);

      // 4. Saring event.
      const decision = classify(envelope);
      if (decision.action === 'ignore') {
        // Nama event asing dicatat di level info: itu cara mengetahui event status sesi v4.
        const level = decision.reason === 'event_unknown' ? 'info' : 'debug';
        logger[level]({ event: envelope.event, reason: decision.reason }, 'Webhook OpenWA diabaikan');
        res.sendStatus(204);
        return;
      }

      // 5. Simpan mentah SEBELUM membalas: unique index inilah yang membuat kiriman ulang aman.
      const { message } = decision;
      const messageLogId = await repository.insertReceived({
        sessionId: envelope.sessionId,
        waMessageId: message.id,
        waChatId: message.chatId,
        messageType: message.type,
        body: textOf(message),
        rawPayload: envelope,
        correlationId: envelope.id ?? null,
      });

      // 6. Balas 204. Kiriman ulang (null) berhenti di sini, tanpa memproses ulang.
      res.sendStatus(204);
      if (messageLogId === null) {
        logger.debug({ event: envelope.event }, 'Kiriman ulang webhook OpenWA diabaikan');
        return;
      }

      // 7. Antrean menerima ID saja, bukan payload. Gagal di sini tidak bisa lagi mengubah balasan,
      //    jadi barisnya ditandai supaya tidak menggantung diam-diam di `received`.
      try {
        await enqueue({ message_log_id: messageLogId });
      } catch (err) {
        logger.error({ err, messageLogId }, 'Gagal memasukkan pesan ke antrean inbound');
        await repository.markEnqueueFailed(messageLogId).catch((markErr: unknown) => {
          logger.error({ err: markErr, messageLogId }, 'Gagal menandai pesan yang tidak masuk antrean');
        });
      }
    }) satisfies RequestHandler,
  };
}
