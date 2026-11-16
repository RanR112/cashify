// Implementasi port untuk job terjadwal. Berkas ini adalah bagian composition root worker,
// bukan modul: di sinilah tabel `whatsapp_accounts`, `budget_categories`, dan `notifications`
// dipertemukan tanpa membuat modul saling mengimpor.
//
// Yang sengaja tidak dilakukan di sini: keputusan siapa dapat pesan, ambang, dan teks pesan.
// Itu ada di notifications.service.ts / budgets.service.ts dan diuji tanpa database.

import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  BudgetAlertAccount,
  BudgetAlertAudience,
} from '../modules/budgets/budgets.types.js';
import type {
  BudgetAlertClaimInput,
  BudgetAlertClaimOutcome,
  BudgetAlertClaimStore,
  DailySummaryAudience,
  DailySummaryReader,
  ScheduledAccountCandidate,
} from '../modules/notifications/notifications.types.js';
import type { TransactionsSummary } from '../modules/transactions/transactions.summary.js';
import { requireUserId } from '../shared/utils/userScope.js';

const accountSelect = {
  id: true,
  userId: true,
  waChatId: true,
  status: true,
  dailySummaryEnabled: true,
  budgetAlertEnabled: true,
  user: { select: { deletedAt: true } },
} satisfies Prisma.WhatsappAccountSelect;

type AccountRow = Prisma.WhatsappAccountGetPayload<{ select: typeof accountSelect }>;

function toCandidate(row: AccountRow): ScheduledAccountCandidate {
  return {
    accountId: row.id,
    userId: row.userId,
    waChatId: row.waChatId,
    status: row.status,
    dailySummaryEnabled: row.dailySummaryEnabled,
    budgetAlertEnabled: row.budgetAlertEnabled,
    userDeletedAt: row.user.deletedAt,
  };
}

export function createDailySummaryAudience(prisma: PrismaClient): DailySummaryAudience {
  return {
    async list(afterAccountId, limit) {
      const rows = await prisma.whatsappAccount.findMany({
        where: { ...(afterAccountId ? { id: { gt: afterAccountId } } : {}) },
        select: accountSelect,
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map(toCandidate);
    },
  };
}

export function createBudgetAlertAudience(prisma: PrismaClient): BudgetAlertAudience {
  return {
    async list(afterAccountId, limit): Promise<BudgetAlertAccount[]> {
      const rows = await prisma.whatsappAccount.findMany({
        where: { ...(afterAccountId ? { id: { gt: afterAccountId } } : {}) },
        select: accountSelect,
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map(toCandidate);
    },
  };
}

/** Adapter tipis: implementasi agregasi tetap di transactions.summary.ts. */
export function createDailySummaryReader(summary: TransactionsSummary): DailySummaryReader {
  return {
    dailyStats: (userId, date) => summary.dailySummary(userId, date),
  };
}

/**
 * Satu transaksi untuk compare-and-set `alert_sent_at` + insert notifikasi.
 *
 * `budget_categories` tidak punya user_id, jadi kepemilikan diperiksa lewat relasi
 * `budget.userId` di WHERE yang sama. Dua eksekusi paralel: yang kalah akan melihat
 * `alert_sent_at` sudah terisi setelah baris dikunci PostgreSQL dan menghasilkan count 0.
 */
export function createBudgetAlertClaimStore(prisma: PrismaClient): BudgetAlertClaimStore {
  return {
    claim(input: BudgetAlertClaimInput): Promise<BudgetAlertClaimOutcome> {
      const owner = requireUserId(input.userId);
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.budgetCategory.updateMany({
          where: {
            id: input.budgetCategoryId,
            budgetId: input.budgetId,
            categoryId: input.categoryId,
            alertSentAt: null,
            budget: { userId: owner, deletedAt: null },
          },
          data: { alertSentAt: input.now },
        });
        if (count === 0) return { status: 'already_sent' as const };

        const row = await tx.notification.create({
          data: {
            userId: owner,
            type: 'budget_alert',
            channel: 'whatsapp',
            title: input.title,
            body: input.body,
            payload: input.payload,
            status: 'pending',
          },
          select: { id: true },
        });
        return { status: 'created' as const, notificationId: row.id };
      });
    },

    async release(input) {
      const owner = requireUserId(input.userId);
      await prisma.$transaction(async (tx) => {
        // Hanya notifikasi yang masih pending yang boleh dikembalikan; bila worker outbound
        // sudah menandainya sent/failed, jangan mengubah apa pun.
        const { count } = await tx.notification.updateMany({
          where: { id: input.notificationId, userId: owner, type: 'budget_alert', status: 'pending' },
          data: { status: 'failed' },
        });
        if (count === 0) return;

        await tx.budgetCategory.updateMany({
          where: {
            id: input.budgetCategoryId,
            budgetId: input.budgetId,
            categoryId: input.categoryId,
            alertSentAt: input.claimedAt,
            budget: { userId: owner },
          },
          data: { alertSentAt: null },
        });
      });
    },
  };
}
