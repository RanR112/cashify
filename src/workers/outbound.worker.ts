// Worker `outbound`: memvalidasi job, mengirim lewat `send`, lalu menjalankan jeda. Pengirim
// sungguhan (WhatsAppGateway.sendText) dipasang oleh src/worker.ts; bawaan di sini hanya mencatat
// log, supaya test tidak mengirim pesan.
//
// ATURAN 12: concurrency 1 dan jeda acak 2-5 detik antar pekerjaan, syarat agar nomor bot tidak
// diblokir WhatsApp. Jedanya dijalankan SESUDAH tiap pekerjaan di dalam processor, jadi slot
// satu-satunya tetap tertahan dan pekerjaan berikutnya baru mulai setelah jeda selesai. Jeda
// juga berlaku bila pengiriman gagal: percobaan ulang pun tidak boleh membanjiri.
//
// SESI TERPUTUS = TUNDA, BUKAN GUGURKAN. Sebelum mengirim, status sesi bot diperiksa (`isConnected`).
// Terputus -> job dipindah ke antrean tertunda (`moveToDelayed` + `DelayedError`), yang TIDAK
// memakai jatah percobaan. Balasan dikirim begitu sesi pulih. Job yang sudah lebih tua dari
// `maxAgeMs` (1 jam) digugurkan: OTP atau jawaban yang basi lebih membingungkan daripada hilang.
//
// Percobaan ulang: 3 kali (OUTBOUND_JOB_OPTIONS), lalu `onExhausted` mencatat gagal.
//
// Saat worker ditutup (SIGTERM), jeda dibatalkan supaya shutdown tidak menunggu hingga 5 detik.
// Pengiriman yang sudah selesai tidak terpengaruh; yang dibatalkan hanya jedanya.

import { DelayedError, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import type { QueueFactoryOptions } from '../queues/inbound.queue.js';
import {
  OUTBOUND_CONCURRENCY,
  OUTBOUND_QUEUE,
  outboundJobSchema,
  randomDelayMs,
  type OutboundJobData,
} from '../queues/outbound.queue.js';
import { maskPhoneForLog } from '../shared/utils/phone.js';
import { isFinalFailure } from './inbound.worker.js';

/** Jeda sebelum sesi yang terputus diperiksa lagi. */
export const DISCONNECTED_RETRY_DELAY_MS = 30_000;
/** Balasan yang sudah selama ini di antrean tidak lagi dikirim. */
export const MAX_JOB_AGE_MS = 60 * 60 * 1000;

export type OutboundSender = (data: OutboundJobData, job: Job<OutboundJobData>) => Promise<void>;
export type OutboundPause = (signal: AbortSignal) => Promise<void>;

export interface OutboundWorkerOptions extends QueueFactoryOptions {
  /** Pengirim sungguhan di worker.ts; bawaannya hanya mencatat log (test). */
  send?: OutboundSender;
  /** Jeda sesudah tiap pekerjaan; harus selesai begitu `signal` dibatalkan. Bawaan: acak 2-5 detik. */
  pause?: OutboundPause;
  /** Status sesi bot (`gateway.getStatus()`). Tanpa ini, tidak ada pemeriksaan (test, atau pengirim yang tahu sendiri). */
  isConnected?: () => Promise<boolean>;
  disconnectedDelayMs?: number;
  maxAgeMs?: number;
  /**
   * Dipanggil sekali ketika job gagal untuk terakhir kalinya (percobaan habis, atau tidak layak diulang).
   * Galat di dalamnya hanya dicatat.
   */
  onExhausted?: (data: OutboundJobData, error: Error) => Promise<void>;
  /** Penyuntik jam untuk test. */
  now?: () => number;
}

/** Tidur `ms` milidetik; selesai lebih awal (tanpa galat) bila `signal` dibatalkan. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const logOnly: OutboundSender = async (data, job) => {
  logger.info(
    { jobId: job.id, waChatId: maskPhoneForLog(data.wa_chat_id), messageLogId: data.message_log_id },
    'Balasan keluar diterima worker (pengirim bawaan: hanya log, tidak dikirim)',
  );
};

const randomPause: OutboundPause = (signal) => abortableSleep(randomDelayMs(), signal);

export function createOutboundWorker(
  connection: ConnectionOptions,
  {
    send = logOnly,
    pause = randomPause,
    prefix,
    isConnected,
    disconnectedDelayMs = DISCONNECTED_RETRY_DELAY_MS,
    maxAgeMs = MAX_JOB_AGE_MS,
    onExhausted,
    now = Date.now,
  }: OutboundWorkerOptions = {},
): Worker<OutboundJobData> {
  const closing = new AbortController();

  const worker = new Worker<OutboundJobData>(
    OUTBOUND_QUEUE,
    async (job, token) => {
      const parsed = outboundJobSchema.safeParse(job.data);
      // Tidak ada yang terkirim, jadi tidak perlu jeda; data salah juga tidak akan benar dengan mencoba ulang.
      if (!parsed.success) throw new UnrecoverableError(`Data job outbound tidak valid: ${parsed.error.message}`);

      if (now() - job.timestamp > maxAgeMs) {
        throw new UnrecoverableError('Balasan terlalu lama menunggu di antrean, tidak dikirim');
      }
      if (isConnected && !(await isConnected())) {
        // Bukan kegagalan: tidak memakai jatah percobaan dan tidak memicu jeda acak (tidak ada yang terkirim).
        await job.moveToDelayed(now() + disconnectedDelayMs, token);
        throw new DelayedError('Sesi WhatsApp terputus, pengiriman ditunda');
      }
      try {
        await send(parsed.data, job);
      } finally {
        await pause(closing.signal);
      }
    },
    // Konstanta, bukan opsi: nilai ini tidak boleh dapat diubah dari luar.
    { connection, concurrency: OUTBOUND_CONCURRENCY, ...(prefix && { prefix }) },
  );

  worker.on('closing', () => closing.abort());
  worker.on('error', (err) => logger.error({ err, queue: OUTBOUND_QUEUE }, 'Kesalahan worker'));
  worker.on('failed', (job, err) => {
    logger.warn({ err, queue: OUTBOUND_QUEUE, jobId: job?.id, attemptsMade: job?.attemptsMade }, 'Job gagal');
    if (!onExhausted || !isFinalFailure(job, err)) return;
    const parsed = outboundJobSchema.safeParse(job?.data);
    if (!parsed.success) return;
    onExhausted(parsed.data, err).catch((cause: unknown) =>
      logger.error({ err: cause, jobId: job?.id }, 'Gagal mencatat balasan yang gagal terkirim'),
    );
  });
  return worker;
}
