import { z } from '../../shared/openapi/zod.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  timestampSchema,
  uuidSchema,
} from '../../shared/schemas/common.schema.js';

// ---- request ----

/** Hanya dua jenis entitas yang ditulis repository saat ini. */
export const auditEntityTypeSchema = z.enum(['transaction', 'budget']).openapi('AuditEntityType');

export const listAuditLogsQuerySchema = paginationQuerySchema.extend({
  entity_type: auditEntityTypeSchema.optional().openapi({
    description: 'Saring menurut jenis entitas. Nilai lain dijawab 400.',
    example: 'transaction',
  }),
  entity_id: uuidSchema.optional().openapi({
    description: 'Saring menurut id entitas asal.',
  }),
});

// ---- cursor ----

/** `i` adalah BIGSERIAL sebagai string: BigInt tidak bisa diserialisasi JSON. */
export const auditLogCursorSchema = z.object({
  t: z.iso.datetime(),
  i: z
    .string()
    .regex(/^\d{1,19}$/)
    .refine((value) => /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n, {
      message: 'Id cursor di luar jangkauan BIGINT',
    }),
});

// ---- respons ----

const auditChangesSideSchema = z.record(z.string(), z.unknown());

export const auditChangesSchema = z
  .object({
    before: auditChangesSideSchema.optional(),
    after: auditChangesSideSchema.optional(),
  })
  .openapi('AuditChanges');

export const auditLogItemSchema = z
  .object({
    entity_type: auditEntityTypeSchema,
    entity_id: uuidSchema,
    action: z.enum(['create', 'update', 'delete', 'restore']).openapi('AuditAction'),
    actor_type: z.enum(['user', 'system', 'whatsapp']).openapi('AuditActorType'),
    changes: auditChangesSchema.nullable(),
    created_at: timestampSchema,
  })
  .openapi('AuditLogItem');

export const auditLogListSchema = paginatedSchema(auditLogItemSchema, 'AuditLogList');