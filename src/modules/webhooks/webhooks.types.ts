import type { InboundJobData } from '../../queues/inbound.queue.js';
import type { InboundMessage } from './webhooks.schema.js';

export interface NewInboundMessage {
  sessionId: string;
  waMessageId: string;
  waChatId: string;
  messageType: string;
  /** Teks pesan; null untuk media tanpa keterangan. */
  body: string | null;
  /** Amplop hasil parse, disimpan utuh di kolom JSONB `raw_payload`. */
  rawPayload: Record<string, unknown>;
  /** `id` amplop OpenWA, untuk menelusuri satu pengiriman. */
  correlationId: string | null;
}

export interface WebhooksRepository {
  /** Id baris baru, atau `null` bila `(session_id, wa_message_id)` sudah ada (kiriman ulang). */
  insertReceived(input: NewInboundMessage): Promise<string | null>;
  /** Menandai baris yang gagal dimasukkan ke antrean, supaya tidak menggantung diam-diam di `received`. */
  markEnqueueFailed(id: string): Promise<void>;
}

export interface WebhooksDeps {
  repository: WebhooksRepository;
  enqueue: (data: InboundJobData) => Promise<unknown>;
  getSecret: () => string | Promise<string>;
}

/** Alasan sebuah webhook dibalas 204 tanpa disimpan. */
export type IgnoreReason = 'event_ignored' | 'event_unknown' | 'from_me' | 'group' | 'ciphertext';

export type WebhookDecision =
  | { action: 'ignore'; reason: IgnoreReason }
  | { action: 'store'; message: InboundMessage };
