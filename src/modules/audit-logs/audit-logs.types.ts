// Tipe internal modul audit-logs. Bentuk request/response ada di audit-logs.schema.ts.
// Modul ini hanya membaca: audit tetap ditulis di repository modul asal.

import type { z } from 'zod';
import type {
  auditLogCursorSchema,
  auditLogItemSchema,
  auditLogListSchema,
  listAuditLogsQuerySchema,
} from './audit-logs.schema.js';

export type AuditLogItem = z.infer<typeof auditLogItemSchema>;
export type AuditLogListBody = z.infer<typeof auditLogListSchema>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
export type AuditLogCursor = z.infer<typeof auditLogCursorSchema>;
export type AuditEntityType = AuditLogItem['entity_type'];

/** Bentuk baris Prisma yang dipilih repository; `id` hanya untuk cursor. */
export interface AuditLogRecord {
  id: bigint;
  entityType: string;
  entityId: string;
  action: string;
  actorType: string;
  changes: unknown;
  createdAt: Date;
}

export interface ListAuditLogsOptions {
  entityType?: AuditEntityType;
  entityId?: string;
  after?: { createdAt: Date; id: bigint };
  limit: number;
}

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface AuditLogsRepository {
  list(userId: string, options: ListAuditLogsOptions): Promise<AuditLogRecord[]>;
}

/** Potongan `changes` yang lolos allowlist; bentuk `{ before, after }` dipertahankan. */
export interface FilteredAuditChanges {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}