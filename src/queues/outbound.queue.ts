// Antrean `outbound`: balasan WhatsApp yang akan dikirim.
//
// ATURAN 12, BUKAN OPTIMASI: concurrency 1 dan jeda acak 2-5 detik antar pekerjaan. Ini syarat
// agar nomor bot tidak diblokir WhatsApp. Jangan dinaikkan, jangan diganti jeda tetap (pola
// yang rapi justru mudah terdeteksi), dan jangan dijalankan di lebih dari satu proses worker:
// dua worker berarti dua kali laju kirim. tests/unit/queue-config.test.ts menjaga nilai-nilai ini.

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';
import type { QueueFactoryOptions } from './inbound.queue.js';

export const OUTBOUND_QUEUE = 'outbound';

export const OUTBOUND_CONCURRENCY = 1;
export const OUTBOUND_DELAY_MIN_MS = 2000;
export const OUTBOUND_DELAY_MAX_MS = 5000;

/**
 * Bilangan bulat acak dalam [2000, 5000] ms, kedua ujung inklusif. `rng` bisa disuntik untuk
 * test; nilainya harus di [0, 1).
 */
export function randomDelayMs(rng: () => number = Math.random): number {
  return OUTBOUND_DELAY_MIN_MS + Math.floor(rng() * (OUTBOUND_DELAY_MAX_MS - OUTBOUND_DELAY_MIN_MS + 1));
}

/** `wa_chat_id` dan `text` diteruskan apa adanya ke `WhatsAppGateway.sendText(to, body)`. */
export const outboundJobSchema = z.object({
  wa_chat_id: z.string().min(1).max(64),
  text: z.string().min(1),
  message_log_id: z.uuid().optional(),
});
export type OutboundJobData = z.infer<typeof outboundJobSchema>;

export const OUTBOUND_JOB_OPTIONS = {
  // Balasan gagal terkirim: coba ulang 3 kali, lalu catat sebagai gagal (ARCHITECTURE.md Bagian 17).
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const satisfies JobsOptions;

export function createOutboundQueue(
  connection: ConnectionOptions,
  { prefix }: QueueFactoryOptions = {},
): Queue<OutboundJobData> {
  return new Queue<OutboundJobData>(OUTBOUND_QUEUE, {
    connection,
    defaultJobOptions: OUTBOUND_JOB_OPTIONS,
    ...(prefix && { prefix }),
  });
}

export interface EnqueueOutboundOptions {
  /**
   * Kunci dedupe: job dengan `jobId` yang sama tidak dimasukkan dua kali. Balasan atas sebuah pesan
   * memakai ini supaya job inbound yang diulang tidak menggandakan balasan. Tanpa ':' (BullMQ menolaknya).
   */
  jobId?: string;
}

export async function enqueueOutbound(
  queue: Queue<OutboundJobData>,
  data: OutboundJobData,
  { jobId }: EnqueueOutboundOptions = {},
) {
  return queue.add('send-message', outboundJobSchema.parse(data), jobId ? { jobId } : {});
}
