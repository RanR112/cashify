import { decodeCursor, encodeCursor } from '../../shared/utils/cursor.js';
import { filterAuditChanges } from './audit-logs.changes.js';
import { auditLogCursorSchema } from './audit-logs.schema.js';
import type {
  AuditEntityType,
  AuditLogItem,
  AuditLogListBody,
  AuditLogsRepository,
  ListAuditLogsQuery,
} from './audit-logs.types.js';

export function createAuditLogsService(repository: AuditLogsRepository) {
  return {
    async list(userId: string, query: ListAuditLogsQuery): Promise<AuditLogListBody> {
      const after = query.cursor ? decodeCursor(query.cursor, auditLogCursorSchema) : null;

      // Satu baris ekstra untuk has_more, tanpa COUNT.
      const rows = await repository.list(userId, {
        entityType: query.entity_type,
        entityId: query.entity_id,
        ...(after && {
          after: { createdAt: new Date(after.t), id: BigInt(after.i) },
        }),
        limit: query.limit + 1,
      });

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);

      return {
        data: page.map(
          (row): AuditLogItem => ({
            entity_type: row.entityType as AuditEntityType,
            entity_id: row.entityId,
            action: row.action as AuditLogItem['action'],
            actor_type: row.actorType as AuditLogItem['actor_type'],
            changes: filterAuditChanges(row.entityType, row.changes),
            created_at: row.createdAt.toISOString(),
          }),
        ),
        // `id` hanya boleh hidup di token opak, tidak pernah di item respons.
        next_cursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id.toString() }) : null,
        has_more: hasMore,
      };
    },
  };
}

export type AuditLogsService = ReturnType<typeof createAuditLogsService>;