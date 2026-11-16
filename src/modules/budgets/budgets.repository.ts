import { Prisma, type PrismaClient } from '@prisma/client';
import { ownedBy, requireUserId, visibleTo } from '../../shared/utils/userScope.js';
import type {
  AuditContext,
  BudgetRecord,
  BudgetsRepository,
  BudgetWriteData,
  CreateOutcome,
  UpdateOutcome,
} from './budgets.types.js';

const recordSelect = {
  id: true,
  userId: true,
  name: true,
  periodType: true,
  periodStart: true,
  periodEnd: true,
  totalAmount: true,
  autoRenew: true,
  rolloverEnabled: true,
  createdAt: true,
  budgetCategories: {
    select: {
      id: true,
      categoryId: true,
      amount: true,
      alertThreshold: true,
      alertSentAt: true,
      category: { select: { name: true, slug: true } },
    },
    orderBy: [{ category: { sortOrder: 'asc' } }, { category: { name: 'asc' } }],
  },
} satisfies Prisma.BudgetSelect;

/** `YYYY-MM-DD` -> tengah malam UTC, bentuk yang dipakai Prisma untuk kolom `@db.Date`. */
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/** Kode galat Prisma untuk pelanggaran unique constraint (termasuk partial unique index). */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/** Snapshot untuk audit_logs; bentuk JSON, tanggal sebagai `YYYY-MM-DD`. */
type AuditSnapshot = {
  name: string | null;
  period_type: string;
  period_start: string;
  period_end: string;
  total_amount: number;
  auto_renew: boolean;
  rollover_enabled: boolean;
  categories: { category_id: string; amount: number; alert_threshold: number }[];
};

function snapshot(record: BudgetRecord): AuditSnapshot {
  return {
    name: record.name,
    period_type: record.periodType,
    period_start: toDateString(record.periodStart),
    period_end: toDateString(record.periodEnd),
    total_amount: record.totalAmount,
    auto_renew: record.autoRenew,
    rollover_enabled: record.rolloverEnabled,
    categories: record.budgetCategories.map((category) => ({
      category_id: category.categoryId,
      amount: category.amount,
      alert_threshold: category.alertThreshold,
    })),
  };
}

/** Hanya field yang berubah, supaya audit update tidak menyalin seluruh baris. */
function changedFields(
  before: BudgetRecord,
  after: BudgetRecord,
): { before: Prisma.InputJsonObject; after: Prisma.InputJsonObject } | null {
  const from = snapshot(before);
  const to = snapshot(after);
  // Nilai di bawah selalu JSON-safe (string, angka, boolean, null, atau array objek);
  // cast diperlukan karena tipe InputJsonValue Prisma tidak memasukkan `null` di akar.
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(to) as (keyof AuditSnapshot)[]) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    changedBefore[key] = from[key];
    changedAfter[key] = to[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : {
        before: changedBefore as Prisma.InputJsonObject,
        after: changedAfter as Prisma.InputJsonObject,
      };
}

function writeAudit(
  tx: Prisma.TransactionClient,
  userId: string,
  entityId: string,
  action: 'create' | 'update' | 'delete',
  changes: Prisma.InputJsonObject,
  audit: AuditContext,
  actorType: 'user' | 'system' = 'user',
) {
  return tx.auditLog.create({
    data: {
      userId,
      entityType: 'budget',
      entityId,
      action,
      changes,
      actorType,
      ipAddress: audit.ipAddress,
    },
  });
}

function categoryRows(categories: BudgetWriteData['categories']) {
  return categories.map((category) => ({
    categoryId: category.categoryId,
    amount: category.amount,
    alertThreshold: category.alertThreshold,
  }));
}

export function createBudgetsRepository(prisma: PrismaClient): BudgetsRepository {
  return {
    list: (userId, status, today) =>
      prisma.budget.findMany({
        where: {
          ...ownedBy(userId),
          ...(status === 'active' && {
            periodStart: { lte: dateOf(today) },
            periodEnd: { gte: dateOf(today) },
          }),
        },
        select: recordSelect,
        // `id` memutus seri periode yang sama sehingga urutan stabil.
        orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
      }),

    findById: (userId, id) =>
      prisma.budget.findFirst({ where: { id, ...ownedBy(userId) }, select: recordSelect }),

    findActive: (userId, today) =>
      prisma.budget.findFirst({
        where: {
          ...ownedBy(userId),
          periodStart: { lte: dateOf(today) },
          periodEnd: { gte: dateOf(today) },
        },
        select: recordSelect,
        orderBy: [{ periodStart: 'desc' }],
      }),

    findOverlapping: (userId, from, to, excludeId) =>
      prisma.budget.findFirst({
        where: {
          ...ownedBy(userId),
          periodStart: { lte: dateOf(to) },
          periodEnd: { gte: dateOf(from) },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      }),

    findVisibleCategories: (userId, ids) =>
      prisma.category.findMany({
        where: { id: { in: ids }, ...visibleTo(userId) },
        select: { id: true, name: true, slug: true, type: true },
      }),

    async create(userId, data, audit) {
      const owner = requireUserId(userId);
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          const record = await tx.budget.create({
            data: {
              userId: owner,
              name: data.name,
              periodType: data.periodType,
              periodStart: dateOf(data.periodStart),
              periodEnd: dateOf(data.periodEnd),
              totalAmount: data.totalAmount,
              autoRenew: data.autoRenew,
              rolloverEnabled: data.rolloverEnabled,
              budgetCategories: { create: categoryRows(data.categories) },
            },
            select: recordSelect,
          });
          await writeAudit(tx, owner, record.id, 'create', { after: snapshot(record) }, audit);
          return { status: 'created' as const, record };
        });
        return outcome;
      } catch (error) {
        // Pelanggaran partial unique index baru ketahuan di sini; transaksi sudah dibatalkan.
        if (isUniqueViolation(error)) return { status: 'conflict' } satisfies CreateOutcome;
        throw error;
      }
    },

    update(userId, id, patch, audit) {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
        const before = await tx.budget.findFirst({
          where: { id, ...ownedBy(owner) },
          select: recordSelect,
        });
        if (!before) return { status: 'not_found' };

        // Kepemilikan sudah diperiksa di transaksi yang sama; budget_categories tidak punya
        // user_id sehingga selalu diakses lewat budgetId milik pengguna ini.
        if (patch.categories) {
          const existing = new Map(before.budgetCategories.map((category) => [category.categoryId, category]));
          const keep = patch.categories.map((category) => category.categoryId);

          await tx.budgetCategory.deleteMany({
            where: { budgetId: id, categoryId: { notIn: keep } },
          });

          for (const allocation of patch.categories) {
            const current = existing.get(allocation.categoryId);
            const changed =
              !current ||
              current.amount !== allocation.amount ||
              current.alertThreshold !== allocation.alertThreshold;

            await tx.budgetCategory.upsert({
              where: { budgetId_categoryId: { budgetId: id, categoryId: allocation.categoryId } },
              create: {
                budgetId: id,
                categoryId: allocation.categoryId,
                amount: allocation.amount,
                alertThreshold: allocation.alertThreshold,
              },
              update: {
                amount: allocation.amount,
                alertThreshold: allocation.alertThreshold,
                // Peringatan boleh terkirim ulang bila batasnya berubah.
                ...(changed && { alertSentAt: null }),
              },
            });
          }
        }

        const record = await tx.budget.update({
          where: { id, ...ownedBy(owner) },
          data: {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.totalAmount !== undefined && { totalAmount: patch.totalAmount }),
            ...(patch.autoRenew !== undefined && { autoRenew: patch.autoRenew }),
            ...(patch.rolloverEnabled !== undefined && { rolloverEnabled: patch.rolloverEnabled }),
          },
          select: recordSelect,
        });

        const changes = changedFields(before, record);
        if (changes) await writeAudit(tx, owner, id, 'update', changes, audit);

        return { status: 'updated', record };
      });
    },

    softDelete(userId, id, audit) {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx) => {
        const deletedAt = new Date();
        const { count } = await tx.budget.updateMany({
          where: { id, ...ownedBy(owner) },
          data: { deletedAt },
        });
        if (count === 0) return false;

        await writeAudit(
          tx,
          owner,
          id,
          'delete',
          { before: { deleted_at: null }, after: { deleted_at: deletedAt.toISOString() } },
          audit,
        );
        return true;
      });
    },

    // Khusus job terjadwal, bukan request pengguna: sengaja tidak memfilter user_id karena
    // tujuannya menemukan semua anggaran yang perlu diperpanjang. Tidak pernah diekspos HTTP.
    listDueRenewals: (today) =>
      prisma.budget.findMany({
        where: {
          autoRenew: true,
          deletedAt: null,
          periodEnd: { lt: dateOf(today) },
        },
        select: recordSelect,
        orderBy: [{ userId: 'asc' }, { periodStart: 'desc' }, { id: 'desc' }],
      }),

    async createRenewal(userId, data) {
      const owner = requireUserId(userId);
      try {
        return await prisma.$transaction(async (tx) => {
          const record = await tx.budget.create({
            data: {
              userId: owner,
              name: data.name,
              periodType: data.periodType,
              periodStart: dateOf(data.periodStart),
              periodEnd: dateOf(data.periodEnd),
              totalAmount: data.totalAmount,
              autoRenew: data.autoRenew,
              rolloverEnabled: data.rolloverEnabled,
              budgetCategories: { create: categoryRows(data.categories) },
            },
            select: recordSelect,
          });
          // Perpanjangan dilakukan sistem, bukan pengguna: actor_type 'system', tanpa IP.
          await writeAudit(
            tx,
            owner,
            record.id,
            'create',
            { after: snapshot(record) },
            { ipAddress: null },
            'system',
          );
          return { status: 'created' as const, record };
        });
      } catch (error) {
        // Partial unique (user_id, period_type, period_start) adalah penjaga idempotensi.
        if (isUniqueViolation(error)) return { status: 'conflict' } satisfies CreateOutcome;
        throw error;
      }
    },
  };
}

export type BudgetsRepositoryImpl = ReturnType<typeof createBudgetsRepository>;
