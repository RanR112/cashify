import type { Prisma, PrismaClient } from '@prisma/client';
import { requireUserId } from '../../shared/utils/userScope.js';
import type { AuditLogsRepository } from './audit-logs.types.js';

// `userId` dan `ipAddress` sengaja tidak dipilih: keduanya tidak pernah masuk respons.
const recordSelect = {
  id: true,
  entityType: true,
  entityId: true,
  action: true,
  actorType: true,
  changes: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export function createAuditLogsRepository(prisma: PrismaClient): AuditLogsRepository {
  return {
    list(userId, { entityType, entityId, after, limit }) {
      const owner = requireUserId(userId);

      // Cursor digabung lewat AND: kurung OR-nya tidak boleh bercampur dengan filter lain.
      const and: Prisma.AuditLogWhereInput[] = [];
      if (after) {
        and.push({
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        });
      }

      return prisma.auditLog.findMany({
        where: {
          userId: owner,
          ...(entityType && { entityType }),
          ...(entityId && { entityId }),
          AND: and,
        },
        select: recordSelect,
        // `id` memutus seri pada created_at yang sama sehingga cursor (created_at, id) tidak ambigu.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
    },
  };
}