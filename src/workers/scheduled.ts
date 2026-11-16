// Composition root job terjadwal. Di sini modul budgets, notifications, dan transactions
// dipertemukan lewat port; ketiganya tidak saling mengimpor. Fungsi ini murni merakit objek:
// tidak ada kueri, tidak ada pengiriman WhatsApp langsung. Semua pengiriman masuk ke antrean
// `outbound` agar throttle concurrency 1 + jeda acak tetap berlaku untuk nomor bot.
//
// Dipakai oleh src/worker.ts dan oleh test integrasi dengan prisma/Redis sungguhan.

import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { createBudgetsRepository } from '../modules/budgets/budgets.repository.js';
import { createBudgetsService } from '../modules/budgets/budgets.service.js';
import { createNotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { createNotificationsService } from '../modules/notifications/notifications.service.js';
import type { ScheduledMessage } from '../modules/notifications/notifications.types.js';
import { createTransactionsSummary } from '../modules/transactions/transactions.summary.js';
import { enqueueOutbound, type OutboundJobData } from '../queues/outbound.queue.js';
import {
  createBudgetAlertAudience,
  createBudgetAlertClaimStore,
  createDailySummaryAudience,
  createDailySummaryReader,
} from './scheduled.ports.js';
import type { ScheduledHandlers } from './scheduled.worker.js';

/** Titik enqueue yang bisa diganti test untuk mensimulasikan Redis mati. */
export type ScheduledEnqueue = (
  data: OutboundJobData,
  options: { jobId: string; delay?: number },
) => Promise<unknown>;

export interface ScheduledJobsDeps {
  prisma: PrismaClient;
  /** Antrean outbound nyata; satu-satunya jalur kirim WhatsApp. */
  outbound: Queue<OutboundJobData>;
  /** Bawaan: enqueueOutbound ke `outbound`. Test kegagalan enqueue menyuntik fungsi ini. */
  enqueue?: ScheduledEnqueue;
  /** Penyuntik acak jitter ringkasan harian; bawaan Math.random. */
  rng?: () => number;
}

export interface ScheduledJobs {
  handlers: ScheduledHandlers;
  /** Diekspos agar test/CLI bisa memanggil logika yang sama tanpa BullMQ. */
  budgets: ReturnType<typeof createBudgetsService>;
  notifications: ReturnType<typeof createNotificationsService>;
}

export function createScheduledJobs({
  prisma,
  outbound,
  enqueue = (data, options) => enqueueOutbound(outbound, data, options),
  rng,
}: ScheduledJobsDeps): ScheduledJobs {
  const notificationsRepository = createNotificationsRepository(prisma);
  const summary = createTransactionsSummary(prisma);

  // Selalu lewat antrean outbound, tidak pernah gateway langsung: worker outbound yang
  // mengatur concurrency 1 dan jeda 2-5 detik (aturan 12).
  const sender = async (message: ScheduledMessage): Promise<void> => {
    await enqueue(
      {
        wa_chat_id: message.waChatId,
        text: message.text,
        notification_id: message.notificationId,
      },
      {
        jobId: message.jobId,
        ...(message.delayMs !== undefined && { delay: message.delayMs }),
      },
    );
  };

  const notifications = createNotificationsService(notificationsRepository, {
    store: notificationsRepository,
    budgetAlerts: createBudgetAlertClaimStore(prisma),
    audience: createDailySummaryAudience(prisma),
    summary: createDailySummaryReader(summary),
    sender,
    ...(rng && { rng }),
  });

  const budgets = createBudgetsService({
    repository: createBudgetsRepository(prisma),
    spending: summary,
    alerts: {
      audience: createBudgetAlertAudience(prisma),
      notifier: {
        deliver: (notice) => notifications.deliverBudgetAlert(notice),
      },
    },
  });

  return {
    budgets,
    notifications,
    handlers: {
      'daily-summary': (now) => notifications.runDailySummary(now),
      'budget-alert': (now) => budgets.scanAlerts(now),
      'renew-budgets': (now) => budgets.renew(now),
    },
  };
}
