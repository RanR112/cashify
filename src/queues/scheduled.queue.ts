// Antrean `scheduled`: job berkala yang tidak dipicu pesan pengguna.
//
// Memakai job scheduler BullMQ (>= 5.16) supaya jadwal hidup di Redis, bukan cron sistem:
// worker yang restart tidak menghapus definisi jadwal. Zona waktu dikunci Asia/Jakarta;
// jam bisnis dan tanggal selalu dihitung lewat shared/utils/timezone.ts di dalam job.
//
// Idempotensi tidak bergantung pada antrean: setiap handler wajib tahan dijalankan dua kali.
// attempts/backoff mengikuti antrean inbound agar kegagalan sementara dicoba ulang.

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';
import type { QueueFactoryOptions } from './inbound.queue.js';

export const SCHEDULED_QUEUE = 'scheduled';

/** Satu job pada satu waktu: pemindaian tidak perlu paralel dan lebih mudah diaudit. */
export const SCHEDULED_CONCURRENCY = 1;

export const SCHEDULED_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const satisfies JobsOptions;

export const SCHEDULED_JOB_NAMES = ['daily-summary', 'budget-alert', 'renew-budgets'] as const;
export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];

/** Job tidak membawa data: parameter waktu disuntik worker, sumber data tetap database. */
export const scheduledJobSchema = z.object({});
export type ScheduledJobData = z.infer<typeof scheduledJobSchema>;

/**
 * Jadwal (cron 5 field) dan zona waktu. `upsertJobScheduler` memakai cron-parser 5.x;
 * jangan menambahkan detik pada pola.
 */
export const SCHEDULES = {
  dailySummary: { pattern: '0 20 * * *', tz: 'Asia/Jakarta' },
  budgetAlert: { pattern: '*/15 * * * *', tz: 'Asia/Jakarta' },
  renewBudgets: { pattern: '5 0 * * *', tz: 'Asia/Jakarta' },
} as const;

export function createScheduledQueue(
  connection: ConnectionOptions,
  { prefix }: QueueFactoryOptions = {},
): Queue<ScheduledJobData> {
  return new Queue<ScheduledJobData>(SCHEDULED_QUEUE, {
    connection,
    defaultJobOptions: SCHEDULED_JOB_OPTIONS,
    ...(prefix && { prefix }),
  });
}

/**
 * Mendaftarkan ketiga jadwal. Aman dipanggil setiap worker start: `upsertJobScheduler`
 * memperbarui definisi yang sudah ada, tidak menggandakan job.
 */
export async function registerScheduledJobs(queue: Queue<ScheduledJobData>): Promise<void> {
  await Promise.all([
    queue.upsertJobScheduler('daily-summary', SCHEDULES.dailySummary, {
      name: 'daily-summary',
      data: {},
    }),
    queue.upsertJobScheduler('budget-alert', SCHEDULES.budgetAlert, {
      name: 'budget-alert',
      data: {},
    }),
    queue.upsertJobScheduler('renew-budgets', SCHEDULES.renewBudgets, {
      name: 'renew-budgets',
      data: {},
    }),
  ]);
}
