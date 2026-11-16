import { logger } from '../../config/logger.js';
import { AppError } from '../../shared/errors/AppError.js';
import { decodeCursor, encodeCursor } from '../../shared/utils/cursor.js';
import { todayInJakarta } from '../../shared/utils/timezone.js';
import { BUDGET_ALERT_TITLE, budgetAlert, DAILY_SUMMARY_TITLE, dailySummary } from './notifications.templates.js';
import { notificationCursorSchema } from './notifications.schema.js';
import type {
  BudgetAlertDelivery,
  DailySummaryRunResult,
  ListNotificationsQuery,
  NotificationBody,
  NotificationListBody,
  NotificationRecord,
  NotificationsRepository,
  NotificationsScheduledDeps,
  NotificationsService,
} from './notifications.types.js';

/** Halaman penerima job; cukup kecil agar tidak menahan banyak akun di memori. */
const SCHEDULED_PAGE_SIZE = 50;
/** Batas keras pesan otomatis per pengguna per hari (WIB). */
const MAX_AUTOMATIC_PER_DAY = 3;
/** Jitter ringkasan harian 0-30 menit (PHASE2-DECISIONS Q5). */
export const DAILY_SUMMARY_DELAY_MAX_MS = 30 * 60 * 1000;

/** Bilangan bulat acak dalam [0, 30 menit], kedua ujung inklusif; `rng` di [0, 1). */
export function dailySummaryDelayMs(rng: () => number = Math.random): number {
  return Math.floor(rng() * (DAILY_SUMMARY_DELAY_MAX_MS + 1));
}

function requireScheduled(deps: NotificationsScheduledDeps | undefined): NotificationsScheduledDeps {
  if (!deps) throw new Error('Job terjadwal notifications belum dirakit');
  return deps;
}

function toNotificationBody(record: NotificationRecord): NotificationBody {
  return {
    id: record.id,
    type: record.type as NotificationBody['type'],
    channel: record.channel as NotificationBody['channel'],
    title: record.title,
    body: record.body,
    status: record.status as NotificationBody['status'],
    scheduled_for: record.scheduledFor?.toISOString() ?? null,
    sent_at: record.sentAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
  };
}

export function createNotificationsService(
  repository: NotificationsRepository,
  scheduled?: NotificationsScheduledDeps,
): NotificationsService {
  return {
    async createWhatsapp(userId, type, title, body, payload, scheduledFor) {
      const row = await repository.createPending(userId, {
        type,
        title,
        body,
        payload,
        ...(scheduledFor !== undefined && { scheduledFor }),
      });
      return row.id;
    },

    async list(userId: string, query: ListNotificationsQuery): Promise<NotificationListBody> {
      const { cursor, limit, status } = query;
      const before = cursor ? decodeCursor(cursor, notificationCursorSchema) : undefined;

      // Satu baris ekstra menjawab "ada halaman berikutnya?" tanpa kueri COUNT.
      const rows = await repository.list(userId, {
        ...(status !== undefined && { status }),
        limit: limit + 1,
        ...(before && { before: { createdAt: new Date(before.t), id: before.i } }),
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit;

      return {
        data: page.map(toNotificationBody),
        next_cursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id }) : null,
        has_more: hasMore,
      };
    },

    async markRead(userId: string, id: string): Promise<NotificationBody> {
      const outcome = await repository.markRead(userId, id);
      if (outcome.status === 'not_found') throw AppError.notFound('Notifikasi tidak ditemukan');
      if (outcome.status === 'conflict') {
        // Hanya `sent` yang boleh menjadi `read`; `pending` belum terkirim, `failed` tidak akan tiba.
        throw AppError.conflict('Notifikasi belum terkirim sehingga belum bisa ditandai dibaca', [
          { field: 'status', issue: 'invalid_transition' },
        ]);
      }
      return toNotificationBody(outcome.record);
    },

    async runDailySummary(now: Date): Promise<DailySummaryRunResult> {
      const deps = requireScheduled(scheduled);
      const date = todayInJakarta(now);
      let targeted = 0;
      let sent = 0;
      let skipped = 0;
      let afterAccountId: string | null = null;

      for (;;) {
        const page = await deps.audience.list(afterAccountId, SCHEDULED_PAGE_SIZE);
        if (page.length === 0) break;

        for (const account of page) {
          // Port hanya membaca baris; sakelar dan status diverifikasi ulang di sini supaya
          // aturan "siapa dapat apa" tetap berada di service dan bisa diuji tanpa database.
          if (account.status !== 'verified' || !account.dailySummaryEnabled || account.userDeletedAt !== null) {
            skipped += 1;
            continue;
          }
          targeted += 1;

          if ((await deps.store.countAutomaticOnDate(account.userId, date)) >= MAX_AUTOMATIC_PER_DAY) {
            skipped += 1;
            continue;
          }
          // Lapis pertama idempotensi; unique expression index menjadi lapis kedua saat balapan.
          if (await deps.store.findDailySummary(account.userId, date)) {
            skipped += 1;
            continue;
          }

          const stats = await deps.summary.dailyStats(account.userId, date);
          // Tidak ada pemasukan dan pengeluaran berarti tidak ada transaksi sama sekali
          // (CHECK amount > 0), jadi jangan kirim pesan kosong.
          if (stats.income === 0 && stats.expense === 0) {
            skipped += 1;
            continue;
          }

          const delayMs = dailySummaryDelayMs(deps.rng);
          const scheduledFor = new Date(now.getTime() + delayMs);
          const text = dailySummary({ date, ...stats });
          const created = await deps.store.createDailySummary(account.userId, {
            title: DAILY_SUMMARY_TITLE,
            body: text,
            date,
            scheduledFor,
          });
          if (created.status !== 'created') {
            skipped += 1;
            continue;
          }

          const jobId = `daily:${account.userId}:${date}`;
          try {
            await deps.sender({
              waChatId: account.waChatId,
              text,
              notificationId: created.id,
              jobId,
              delayMs,
              scheduledFor,
            });
            sent += 1;
          } catch (error) {
            // Baris tetap ada dan ditandai failed: job ini tidak diulang untuk hari yang sama,
            // tetapi status di database tidak menggantung di pending.
            skipped += 1;
            logger.warn(
              { err: error, notificationId: created.id, jobId },
              'Gagal memasukkan ringkasan harian ke antrean outbound',
            );
            try {
              await repository.markFailed(created.id);
            } catch (markError) {
              logger.error(
                { err: markError, notificationId: created.id },
                'Gagal menandai ringkasan harian gagal',
              );
            }
          }
        }

        if (page.length < SCHEDULED_PAGE_SIZE) break;
        afterAccountId = page[page.length - 1]!.accountId;
      }

      return { targeted, sent, skipped };
    },

    async deliverBudgetAlert(input: BudgetAlertDelivery): Promise<'sent' | 'skipped'> {
      const deps = requireScheduled(scheduled);
      const date = todayInJakarta(input.now);

      // Batas harian diperiksa sebelum klaim; kalau penuh, alert_sent_at tidak dipakai
      // sehingga kategori ini dicoba lagi pada pemindaian berikutnya.
      if ((await deps.store.countAutomaticOnDate(input.userId, date)) >= MAX_AUTOMATIC_PER_DAY) {
        return 'skipped';
      }

      const text = budgetAlert({
        budgetName: input.budgetName,
        categoryName: input.categoryName,
        spent: input.spent,
        amount: input.amount,
      });
      const claim = await deps.budgetAlerts.claim({
        userId: input.userId,
        budgetId: input.budgetId,
        budgetCategoryId: input.budgetCategoryId,
        categoryId: input.categoryId,
        now: input.now,
        title: BUDGET_ALERT_TITLE,
        body: text,
        // Payload hanya id internal (PHASE2-DECISIONS §5.11); teks tidak pernah disimpan di sini.
        payload: { budget_id: input.budgetId, category_id: input.categoryId },
      });
      if (claim.status !== 'created') return 'skipped';

      const jobId = `alert:${input.budgetCategoryId}:${input.periodStart}`;
      try {
        await deps.sender({
          waChatId: input.waChatId,
          text,
          notificationId: claim.notificationId,
          jobId,
          delayMs: 0,
        });
        return 'sent';
      } catch (error) {
        logger.warn(
          { err: error, notificationId: claim.notificationId, jobId },
          'Gagal memasukkan peringatan anggaran ke antrean outbound',
        );
        try {
          await deps.budgetAlerts.release({
            userId: input.userId,
            budgetId: input.budgetId,
            budgetCategoryId: input.budgetCategoryId,
            categoryId: input.categoryId,
            notificationId: claim.notificationId,
            claimedAt: input.now,
          });
        } catch (releaseError) {
          logger.error(
            { err: releaseError, notificationId: claim.notificationId },
            'Gagal mengembalikan status peringatan anggaran',
          );
        }
        return 'skipped';
      }
    },
  };
}
