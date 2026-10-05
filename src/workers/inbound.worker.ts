// Worker `inbound`: pembungkus BullMQ di sekitar pemroses pesan masuk. Logika WhatsApp-nya ada di
// inbound.processor.ts (dirakit di src/worker.ts); di sini hanya urusan antrean: validasi job,
// concurrency, dan apa yang terjadi ketika job akhirnya gagal.
//
// Pemroses bawaan hanya mencatat log, supaya test antrean tidak butuh database dan Redis helper.

import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import {
  INBOUND_CONCURRENCY,
  INBOUND_QUEUE,
  inboundJobSchema,
  type InboundJobData,
  type QueueFactoryOptions,
} from '../queues/inbound.queue.js';

export type InboundProcessor = (data: InboundJobData, job: Job<InboundJobData>) => Promise<void>;

export interface InboundWorkerOptions extends QueueFactoryOptions {
  /** Bisa diganti di test; bawaannya hanya mencatat log. */
  processor?: InboundProcessor;
  concurrency?: number;
  /**
   * Dipanggil sekali ketika sebuah job gagal untuk terakhir kalinya (percobaan habis, atau galat yang
   * tidak layak diulang). Dipakai menandai pesan `failed` di database supaya tidak menggantung di
   * `received`. Galat di dalamnya hanya dicatat.
   */
  onExhausted?: (data: InboundJobData, error: Error) => Promise<void>;
}

const logOnly: InboundProcessor = async (data, job) => {
  logger.info({ jobId: job.id, messageLogId: data.message_log_id }, 'Pesan masuk diterima worker (pemroses bawaan: hanya log)');
};

/** True bila BullMQ tidak akan mencoba job ini lagi. */
export function isFinalFailure(job: Job | undefined, error: Error): boolean {
  if (!job) return false;
  return error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
}

export function createInboundWorker(
  connection: ConnectionOptions,
  { processor = logOnly, concurrency = INBOUND_CONCURRENCY, prefix, onExhausted }: InboundWorkerOptions = {},
): Worker<InboundJobData> {
  const worker = new Worker<InboundJobData>(
    INBOUND_QUEUE,
    async (job) => {
      const parsed = inboundJobSchema.safeParse(job.data);
      // Data yang salah tidak akan benar dengan mencoba ulang.
      if (!parsed.success) throw new UnrecoverableError(`Data job inbound tidak valid: ${parsed.error.message}`);
      await processor(parsed.data, job);
    },
    { connection, concurrency, ...(prefix && { prefix }) },
  );

  // Tanpa listener `error`, gangguan Redis menjatuhkan proses.
  worker.on('error', (err) => logger.error({ err, queue: INBOUND_QUEUE }, 'Kesalahan worker'));
  worker.on('failed', (job, err) => {
    logger.warn({ err, queue: INBOUND_QUEUE, jobId: job?.id, attemptsMade: job?.attemptsMade }, 'Job gagal');
    if (!onExhausted || !isFinalFailure(job, err)) return;
    const parsed = inboundJobSchema.safeParse(job?.data);
    if (!parsed.success) return; // data rusak: tidak ada pesan yang bisa ditandai
    onExhausted(parsed.data, err).catch((cause: unknown) =>
      logger.error({ err: cause, messageLogId: parsed.data.message_log_id }, 'Gagal menandai pesan sebagai failed'),
    );
  });
  return worker;
}
