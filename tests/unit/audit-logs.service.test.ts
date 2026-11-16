// Aturan service audit-logs dengan repository palsu, tanpa database.
// Perilaku SQL (isolasi pengguna, filter, paginasi) diuji di tests/integration/audit-logs.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createAuditLogsService } from '../../src/modules/audit-logs/audit-logs.service.js';
import { auditLogCursorSchema } from '../../src/modules/audit-logs/audit-logs.schema.js';
import type { AuditLogRecord } from '../../src/modules/audit-logs/audit-logs.types.js';
import { decodeCursor, encodeCursor } from '../../src/shared/utils/cursor.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const ENTITY = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = new Date('2026-10-05T13:00:00.000Z');

const row = (overrides: Partial<AuditLogRecord> = {}): AuditLogRecord => ({
  id: 42n,
  entityType: 'transaction',
  entityId: ENTITY,
  action: 'update',
  actorType: 'user',
  changes: {
    before: { amount: 1000, ip_address: '203.0.113.7' },
    after: { amount: 2000, phone: '+628123456789' },
  },
  createdAt: CREATED_AT,
  ...overrides,
});

describe('cursor audit-logs', () => {
  it('round-trip mempertahankan created_at dan id sebagai string', () => {
    const payload = { t: '2026-10-05T13:00:00.000Z', i: '42' };
    expect(decodeCursor(encodeCursor(payload), auditLogCursorSchema)).toEqual(payload);
  });

  it('menolak id yang bukan digit, terlalu panjang, atau di luar BIGINT', () => {
    expect(auditLogCursorSchema.safeParse({ t: '2026-10-05T13:00:00.000Z', i: 'abc' }).success).toBe(false);
    expect(auditLogCursorSchema.safeParse({ t: '2026-10-05T13:00:00.000Z', i: '1'.repeat(20) }).success).toBe(false);
    expect(
      auditLogCursorSchema.safeParse({ t: '2026-10-05T13:00:00.000Z', i: '9223372036854775808' }).success,
    ).toBe(false);
  });

  it('menolak timestamp tidak valid dan field wajib yang hilang', () => {
    expect(auditLogCursorSchema.safeParse({ t: 'kemarin', i: '42' }).success).toBe(false);
    expect(auditLogCursorSchema.safeParse({ t: '2026-10-05T13:00:00.000Z' }).success).toBe(false);
  });
});

describe('createAuditLogsService.list', () => {
  it('meminta satu baris ekstra, membuang id, dan menyaring changes', async () => {
    const list = vi.fn(async () => [row(), row({ id: 41n, entityId: '22222222-2222-4222-8222-222222222222' })]);
    const service = createAuditLogsService({ list });

    const result = await service.list(USER, { limit: 1 });

    expect(list).toHaveBeenCalledWith(USER, { limit: 2, entityType: undefined, entityId: undefined });
    expect(result.has_more).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual({
      entity_type: 'transaction',
      entity_id: ENTITY,
      action: 'update',
      actor_type: 'user',
      changes: { before: { amount: 1000 }, after: { amount: 2000 } },
      created_at: '2026-10-05T13:00:00.000Z',
    });
    expect(Object.keys(result.data[0] ?? {})).toEqual([
      'entity_type',
      'entity_id',
      'action',
      'actor_type',
      'changes',
      'created_at',
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.next_cursor).not.toBeNull();
    expect(decodeCursor(result.next_cursor as string, auditLogCursorSchema)).toEqual({
      t: '2026-10-05T13:00:00.000Z',
      i: '42',
    });
  });

  it('meneruskan filter dan cursor sebagai Date + BigInt ke repository', async () => {
    const list = vi.fn(async () => []);
    const service = createAuditLogsService({ list });
    const cursor = encodeCursor({ t: '2026-10-05T13:00:00.000Z', i: '42' });

    await service.list(USER, {
      limit: 20,
      entity_type: 'budget',
      entity_id: ENTITY,
      cursor,
    });

    expect(list).toHaveBeenCalledWith(USER, {
      entityType: 'budget',
      entityId: ENTITY,
      after: { createdAt: CREATED_AT, id: 42n },
      limit: 21,
    });
  });

  it('halaman terakhir: next_cursor null dan has_more false', async () => {
    const list = vi.fn(async () => [row()]);
    const service = createAuditLogsService({ list });

    const result = await service.list(USER, { limit: 20 });

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it('changes null tetap null', async () => {
    const list = vi.fn(async () => [row({ changes: null })]);
    const service = createAuditLogsService({ list });

    expect((await service.list(USER, { limit: 20 })).data[0]?.changes).toBeNull();
  });
});