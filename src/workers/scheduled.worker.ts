// Worker `scheduled`: menjalankan job berkala (ringkasan harian, peringatan anggaran,
// perpanjangan anggaran). Yang ada di sini hanya urusan antrean — validasi nama/data job,
// concurrency, penyuntikan jam, dan log. Logika bisnisnya ada di service modul dan dirakit
// oleh src/workers/scheduled.ts; dengan begitu bisa diuji tanpa Redis.
//
// Semua handler WAJIB idempoten: BullMQ bisa menjalankan job yang sama lagi setelah worker
// restart atau retry. Idempotensi tidak disediakan oleh worker ini.

import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { logger } from '../config/logger.js';
import type { QueueFactoryOptions } from '../queues/inbound.queue.js';
import {
  SCHEDULED_CONCURRENCY,
  SCHEDULED_JOB_NAMES,
  SCHEDULED_QUEUE,
  scheduledJobSchema,
  type ScheduledJobData,
  type ScheduledJobName,
} from '../queues/scheduled.queue.js';

/** Handler menerima `now` agar logika tidak pernah memanggil Date.now() sendiri. */
export type ScheduledHandler = (now: Date) => Promise<unknown>;

export interface ScheduledHandlers {
  'daily-summary': ScheduledHandler;
  'budget-alert': ScheduledHandler;
  'renew-budgets': ScheduledHandler;
}

export interface ScheduledWorkerOptions extends QueueFactoryOptions {
  /** Dirakit composition root; tanpa ini job hanya dicatat (test antrean tanpa DB). */
  handlers?: ScheduledHandlers;
  /** Penyuntik jam untuk test. */
  now?: () => Date;
  concurrency?: number;
}

function isScheduledJobName(name: string): name is ScheduledJobName {
  return (SCHEDULED_JOB_NAMES as readonly string[]).includes(name);
}

export function createScheduledWorker(
  connection: ConnectionOptions,
  { handlers, prefix, now = () => new Date(), concurrency = SCHEDULED_CONCURRENCY }: ScheduledWorkerOptions = {},
): Worker<ScheduledJobData> {
  const worker = new Worker<ScheduledJobData>(
    SCHEDULED_QUEUE,
    async (job) => {
      const parsed = scheduledJobSchema.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError(`Data job scheduled tidak valid: ${parsed.error.message}`);
      }
      if (!isScheduledJobName(job.name)) {
        throw new UnrecoverableError(`Nama job scheduled tidak dikenal: ${job.name}`);
      }

      const handler = handlers?.[job.name];
      if (!handler) {
        // Test antrean memulai worker tanpa handler; jangan gagalkan job yang sah hanya
        // karena tidak ada yang memasang logika di proses itu.
        logger.info({ jobId: job.id, name: job.name }, 'Job scheduled diterima (handler belum dirakit: hanya log)');
        return;
      }

      // Satu `now` untuk seluruh job, diambil saat eksekusi; ini bukan aturan bisnis.
      return handler(now());
    },
    { connection, concurrency, ...(prefix && { prefix }) },
  );

  // Tanpa listener `error`, gangguan Redis menjatuhkan proses.
  worker.on('error', (err) => logger.error({ err, queue: SCHEDULED_QUEUE }, 'Kesalahan worker scheduled'));
  worker.on('failed', (job, err) => {
    logger.warn(
      { err, queue: SCHEDULED_QUEUE, jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade },
      'Job scheduled gagal',
    );
  });
  return worker;
}
