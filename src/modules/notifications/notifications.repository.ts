import { Prisma, type PrismaClient } from '@prisma/client';
import { addDays, jakartaDayStartUtc } from '../../shared/utils/timezone.js';
import { requireUserId } from '../../shared/utils/userScope.js';
import type {
  DailySummaryCreateOutcome,
  ListNotificationsOptions,
  MarkReadOutcome,
  NotificationsScheduledRepository,
} from './notifications.types.js';

/** Kode galat Prisma untuk pelanggaran unique constraint (termasuk expression index). */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

// `payload` sengaja tidak dipilih: isinya internal (id dan tanggal) dan tidak pernah masuk response.
const recordSelect = {
  id: true,
  type: true,
  channel: true,
  title: true,
  body: true,
  status: true,
  scheduledFor: true,
  sentAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

// `notifications` tidak punya `deleted_at` (PHASE2-DECISIONS §5.17), jadi tidak ada filter
// soft delete. Filter `user_id` tetap wajib untuk setiap metode yang menerima userId.
export function createNotificationsRepository(prisma: PrismaClient): NotificationsScheduledRepository {
  return {
    async createPending(userId, input) {
      const row = await prisma.notification.create({
        data: {
          userId: requireUserId(userId),
          type: input.type,
          // Satu-satunya kanal yang dibuat sistem (PHASE2-DECISIONS Q8).
          channel: 'whatsapp',
          title: input.title,
          body: input.body,
          payload: input.payload,
          status: 'pending',
          scheduledFor: input.scheduledFor ?? null,
        },
        select: { id: true },
      });
      return row;
    },

    async list(userId: string, { status, limit, before }: ListNotificationsOptions) {
      const owner = requireUserId(userId);
      return prisma.notification.findMany({
        where: {
          userId: owner,
          ...(status && { status }),
          // `created_at` di Prisma hanya presisi milidetik, sedangkan kolomnya TIMESTAMPTZ(6).
          // Notifikasi dibuat satu per satu, sehingga nilai yang jatuh di milidetik yang sama
          // praktis tidak ada; `id` menjadi pemecah seri seperti paginasi transaksi.
          ...(before && {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }),
        },
        select: recordSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
    },

    /**
     * Transisi `sent -> read` di dalam satu transaksi. Baris milik pengguna lain tidak pernah
     * terlihat (404 di service), dan `updateMany` dengan `status = 'sent'` membuat dua permintaan
     * bersamaan tidak bisa sama-sama "menang".
     */
    markRead(userId: string, id: string): Promise<MarkReadOutcome> {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx): Promise<MarkReadOutcome> => {
        const existing = await tx.notification.findFirst({
          where: { id, userId: owner },
          select: recordSelect,
        });
        if (!existing) return { status: 'not_found' };
        // Idempoten: `read` yang diulang tetap 200, dan `sent_at` tidak disentuh.
        if (existing.status === 'read') return { status: 'read', record: existing };
        if (existing.status !== 'sent') return { status: 'conflict' };

        const { count } = await tx.notification.updateMany({
          where: { id, userId: owner, status: 'sent' },
          data: { status: 'read' },
        });
        if (count === 0) return { status: 'conflict' };

        const record = await tx.notification.findFirstOrThrow({
          where: { id, userId: owner },
          select: recordSelect,
        });
        return { status: 'read', record };
      });
    },

    /**
     * Dipanggil worker outbound, bukan pengguna: `id` berasal dari job (sudah UUID), bukan input
     * HTTP, sehingga tidak ada `requireUserId` di sini. `status = 'pending'` membatasi agar
     * notifikasi yang sudah `sent`/`failed`/`read` tidak berubah.
     */
    async markSent(notificationId: string) {
      const { count } = await prisma.notification.updateMany({
        where: { id: notificationId, status: 'pending' },
        data: { status: 'sent', sentAt: new Date() },
      });
      return count === 1;
    },

    /** Alasan kegagalan tidak disimpan: tabel tidak punya kolomnya dan `payload` hanya id/tanggal. */
    async markFailed(notificationId: string) {
      const { count } = await prisma.notification.updateMany({
        where: { id: notificationId, status: 'pending' },
        data: { status: 'failed' },
      });
      return count === 1;
    },

    // ---- operasi job terjadwal (satu tabel notifications) ----

    async findDailySummary(userId: string, date: string) {
      const owner = requireUserId(userId);
      return prisma.notification.findFirst({
        where: {
          userId: owner,
          type: 'daily_summary',
          // `payload.date` adalah satu-satunya sumber tanggal; kolom created_at tidak dipakai
          // karena job bisa berjalan lewat tengah malam saat retry.
          payload: { path: ['date'], equals: date },
        },
        select: { id: true },
      });
    },

    /**
     * Cek lalu create. Balapan tetap mungkin terjadi setelah cek; unique expression index
     * `notifications_daily_summary_key` menangkapnya dan diterjemahkan menjadi `exists`.
     */
    async createDailySummary(userId: string, input): Promise<DailySummaryCreateOutcome> {
      const owner = requireUserId(userId);
      const existing = await prisma.notification.findFirst({
        where: {
          userId: owner,
          type: 'daily_summary',
          payload: { path: ['date'], equals: input.date },
        },
        select: { id: true },
      });
      if (existing) return { status: 'exists' };

      try {
        const row = await prisma.notification.create({
          data: {
            userId: owner,
            type: 'daily_summary',
            channel: 'whatsapp',
            title: input.title,
            body: input.body,
            payload: { date: input.date },
            status: 'pending',
            scheduledFor: input.scheduledFor ?? null,
          },
          select: { id: true },
        });
        return { status: 'created', id: row.id };
      } catch (error) {
        if (isUniqueViolation(error)) return { status: 'exists' };
        throw error;
      }
    },

    /**
     * Batas keras tiga pesan otomatis per pengguna per hari (WIB). Status `failed` tidak
     * dihitung karena pesan itu tidak akan tiba; `pending` dihitung agar kuota tidak
     * terlampaui saat pesan masih menunggu antrean.
     */
    async countAutomaticOnDate(userId: string, date: string) {
      const owner = requireUserId(userId);
      const from = jakartaDayStartUtc(date);
      const to = jakartaDayStartUtc(addDays(date, 1));
      return prisma.notification.count({
        where: {
          userId: owner,
          type: { in: ['daily_summary', 'budget_alert'] },
          channel: 'whatsapp',
          status: { in: ['pending', 'sent', 'read'] },
          createdAt: { gte: from, lt: to },
        },
      });
    },
  };
}
