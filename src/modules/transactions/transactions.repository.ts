import type { Prisma, PrismaClient } from '@prisma/client';
import { ownedBy, requireUserId, visibleTo } from '../../shared/utils/userScope.js';
import type {
  AuditContext,
  TransactionPatch,
  TransactionRecord,
  TransactionsRepository,
} from './transactions.types.js';

const recordSelect = {
  id: true,
  type: true,
  amount: true,
  date: true,
  occurredAt: true,
  description: true,
  source: true,
  categoryId: true,
  accountId: true,
  category: { select: { id: true, name: true, icon: true, color: true } },
  account: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TransactionSelect;

const detailSelect = {
  ...recordSelect,
  sourceMessage: { select: { body: true, createdAt: true } },
} satisfies Prisma.TransactionSelect;

/** `YYYY-MM-DD` -> tengah malam UTC, bentuk yang dipakai Prisma untuk kolom `@db.Date`. */
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Field yang dicatat di audit_logs. Nama kolom API (snake_case), bukan nama Prisma. */
function snapshot(record: TransactionRecord): Record<string, string | number | null> {
  return {
    type: record.type,
    amount: record.amount,
    date: record.date.toISOString().slice(0, 10),
    description: record.description,
    category_id: record.categoryId,
    account_id: record.accountId,
  };
}

/** Hanya field yang berbeda, sebagai `{ before, after }`. */
function diffSnapshots(before: TransactionRecord, after: TransactionRecord): Prisma.InputJsonObject {
  const [a, b] = [snapshot(before), snapshot(after)];
  const changedBefore: Record<string, string | number | null> = {};
  const changedAfter: Record<string, string | number | null> = {};
  for (const key of Object.keys(b)) {
    if (a[key] !== b[key]) {
      changedBefore[key] = a[key] ?? null;
      changedAfter[key] = b[key] ?? null;
    }
  }
  return { before: changedBefore, after: changedAfter };
}

function hasChanges(before: TransactionRecord, patch: TransactionPatch): boolean {
  return (
    (patch.type !== undefined && patch.type !== before.type) ||
    (patch.amount !== undefined && patch.amount !== before.amount) ||
    (patch.categoryId !== undefined && patch.categoryId !== before.categoryId) ||
    (patch.accountId !== undefined && patch.accountId !== before.accountId) ||
    (patch.description !== undefined && patch.description !== before.description) ||
    (patch.occurredAt !== undefined && patch.occurredAt.getTime() !== before.occurredAt.getTime())
  );
}

function writeAudit(
  tx: Prisma.TransactionClient,
  userId: string,
  entityId: string,
  action: 'create' | 'update' | 'delete' | 'restore',
  changes: Prisma.InputJsonObject,
  audit: AuditContext,
) {
  return tx.auditLog.create({
    data: {
      userId,
      entityType: 'transaction',
      entityId,
      action,
      changes,
      actorType: 'user',
      ipAddress: audit.ipAddress,
    },
  });
}

export function createTransactionsRepository(prisma: PrismaClient): TransactionsRepository {
  return {
    list(userId, { filters, after, limit }) {
      const owner = requireUserId(userId);
      const date: Prisma.DateTimeFilter = {};
      if (filters.from) date.gte = dateOf(filters.from);
      if (filters.to) date.lte = dateOf(filters.to);

      // Cursor digabung lewat AND: kurung OR-nya tidak boleh bercampur dengan filter lain.
      const and: Prisma.TransactionWhereInput[] = [];
      if (after) {
        const cursorDate = dateOf(after.date);
        and.push({ OR: [{ date: { lt: cursorDate } }, { date: cursorDate, id: { lt: after.id } }] });
      }

      return prisma.transaction.findMany({
        where: {
          ...ownedBy(owner),
          ...((filters.from || filters.to) && { date }),
          ...(filters.type && { type: filters.type }),
          ...(filters.categoryId && { categoryId: filters.categoryId }),
          ...(filters.accountId && { accountId: filters.accountId }),
          ...(filters.source && { source: filters.source }),
          ...(filters.q && { description: { contains: filters.q, mode: 'insensitive' } }),
          AND: and,
        },
        select: recordSelect,
        // `id` memutus seri pada tanggal yang sama sehingga cursor (date, id) tidak ambigu.
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: limit,
      });
    },

    findById: (userId, id) =>
      prisma.transaction.findFirst({ where: { id, ...ownedBy(userId) }, select: detailSelect }),

    create: (userId, data, audit) => {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx) => {
        const record = await tx.transaction.create({
          data: { ...data, userId: owner, source: 'manual' },
          select: recordSelect,
        });
        await writeAudit(tx, owner, record.id, 'create', { after: snapshot(record) }, audit);
        return record;
      });
    },

    update: (userId, id, expectedUpdatedAt, patch, audit) => {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx) => {
        // Kunci baris dulu: tanpa ini dua PATCH serentak dengan updated_at sama sama-sama lolos
        // pemeriksaan di bawah, dan yang kedua diam-diam menimpa yang pertama.
        await tx.$queryRaw`
          SELECT id FROM transactions
          WHERE id = ${id}::uuid AND user_id = ${owner}::uuid AND deleted_at IS NULL
          FOR UPDATE`;

        const before = await tx.transaction.findFirst({ where: { id, ...ownedBy(owner) }, select: recordSelect });
        if (!before) return { status: 'not_found' as const };
        // Kedua sisi dibaca lewat Prisma, jadi presisinya sama (milidetik) walau kolomnya mikrodetik.
        if (before.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'conflict' as const };
        if (!hasChanges(before, patch)) return { status: 'updated' as const, record: before };

        // Dipaksa maju minimal 1 ms: dua update dalam milidetik yang sama tidak boleh menghasilkan
        // updated_at identik, atau klien yang basi lolos pemeriksaan.
        const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1));
        const record = await tx.transaction.update({
          where: { id, ...ownedBy(owner) },
          data: { ...patch, updatedAt },
          select: recordSelect,
        });
        await writeAudit(tx, owner, id, 'update', diffSnapshots(before, record), audit);
        return { status: 'updated' as const, record };
      });
    },

    softDelete: (userId, id, audit) => {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx) => {
        const deletedAt = new Date();
        const { count } = await tx.transaction.updateMany({
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

    restore: (userId, id, audit) => {
      const owner = requireUserId(userId);
      return prisma.$transaction(async (tx) => {
        const deleted = await tx.transaction.findFirst({
          where: { id, userId: owner, deletedAt: { not: null } },
          select: { deletedAt: true },
        });
        if (!deleted?.deletedAt) return null;

        const { count } = await tx.transaction.updateMany({
          where: { id, userId: owner, deletedAt: { not: null } },
          data: { deletedAt: null },
        });
        if (count === 0) return null;

        await writeAudit(
          tx,
          owner,
          id,
          'restore',
          { before: { deleted_at: deleted.deletedAt.toISOString() }, after: { deleted_at: null } },
          audit,
        );
        return tx.transaction.findFirst({ where: { id, ...ownedBy(owner) }, select: recordSelect });
      });
    },

    findVisibleCategory: (userId, categoryId) =>
      prisma.category.findFirst({ where: { id: categoryId, ...visibleTo(userId) }, select: { id: true, type: true } }),

    findOwnedAccount: (userId, accountId) =>
      prisma.account.findFirst({ where: { id: accountId, ...ownedBy(userId) }, select: { id: true } }),
  };
}
