// Aturan service notifications dengan repository palsu, tanpa database.
// Perilaku SQL (transisi status hanya dari pending, isolasi pengguna, cursor) diuji di
// tests/integration/notifications.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createNotificationsService } from '../../src/modules/notifications/notifications.service.js';
import type {
  NotificationRecord,
  NotificationsRepository,
} from '../../src/modules/notifications/notifications.types.js';
import type { ListNotificationsQuery } from '../../src/modules/notifications/notifications.types.js';
import { AppError } from '../../src/shared/errors/AppError.js';
import { decodeCursor, encodeCursor } from '../../src/shared/utils/cursor.js';
import { notificationCursorSchema } from '../../src/modules/notifications/notifications.schema.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const NOTIF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SENT_AT = new Date('2026-10-05T13:00:00.000Z');
const CREATED_AT = new Date('2026-10-05T13:00:00.000Z');

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: NOTIF_ID,
    type: 'daily_summary',
    channel: 'whatsapp',
    title: 'Ringkasan harian',
    body: 'Masuk: Rp0',
    status: 'sent',
    scheduledFor: null,
    sentAt: SENT_AT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<NotificationsRepository> = {}): NotificationsRepository {
  return {
    createPending: vi.fn(async () => ({ id: NOTIF_ID })),
    list: vi.fn(async () => []),
    markRead: vi.fn(async () => ({ status: 'not_found' as const })),
    markSent: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    ...overrides,
  };
}

const query = (overrides: Partial<ListNotificationsQuery> = {}): ListNotificationsQuery => ({
  limit: 20,
  ...overrides,
});

describe('notifications.service', () => {
  it('createWhatsapp membuat baris pending dan mengembalikan id-nya', async () => {
    const repository = fakeRepository();
    const service = createNotificationsService(repository);

    const id = await service.createWhatsapp(USER, 'budget_alert', 'Peringatan anggaran', 'Isi pesan', {
      budget_id: 'b1',
      category_id: 'c1',
    });

    expect(id).toBe(NOTIF_ID);
    expect(repository.createPending).toHaveBeenCalledWith(USER, {
      type: 'budget_alert',
      title: 'Peringatan anggaran',
      body: 'Isi pesan',
      payload: { budget_id: 'b1', category_id: 'c1' },
    });
  });

  it('createWhatsapp meneruskan scheduled_for bila diberikan', async () => {
    const repository = fakeRepository();
    const service = createNotificationsService(repository);
    const scheduledFor = new Date('2026-10-06T00:00:00.000Z');

    await service.createWhatsapp(USER, 'daily_summary', 'Ringkasan harian', 'Isi', { date: '2026-10-06' }, scheduledFor);

    expect(repository.createPending).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ scheduledFor, payload: { date: '2026-10-06' } }),
    );
  });

  it('list: meminta satu baris ekstra dan melaporkan has_more serta cursor halaman', async () => {
    const older = record({ id: OTHER_ID, createdAt: new Date('2026-10-05T12:00:00.000Z') });
    const rows = [record(), older, record({ id: '33333333-3333-4333-8333-333333333333' })];
    const repository = fakeRepository({ list: vi.fn(async () => rows) });
    const service = createNotificationsService(repository);

    const page = await service.list(USER, query({ limit: 2 }));

    expect(repository.list).toHaveBeenCalledWith(USER, { limit: 3 });
    expect(page.data).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeCursor(page.next_cursor!, notificationCursorSchema)).toEqual({
      t: older.createdAt.toISOString(),
      i: OTHER_ID,
    });
  });

  it('list: tepat sejumlah limit berarti tidak ada halaman berikutnya', async () => {
    const repository = fakeRepository({ list: vi.fn(async () => [record(), record({ id: OTHER_ID })]) });
    const service = createNotificationsService(repository);

    const page = await service.list(USER, query({ limit: 2 }));

    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('list: cursor dan filter status diteruskan ke repository', async () => {
    const repository = fakeRepository({ list: vi.fn(async () => []) });
    const service = createNotificationsService(repository);
    const cursor = encodeCursor({ t: SENT_AT.toISOString(), i: NOTIF_ID });

    await service.list(USER, query({ cursor, status: 'failed', limit: 5 }));

    expect(repository.list).toHaveBeenCalledWith(USER, {
      status: 'failed',
      limit: 6,
      before: { createdAt: SENT_AT, id: NOTIF_ID },
    });
  });

  it('list: cursor rusak dijawab 400, bukan diteruskan ke repository', async () => {
    const repository = fakeRepository();
    const service = createNotificationsService(repository);

    await expect(service.list(USER, query({ cursor: 'bukan-cursor' }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('list: payload dan field internal tidak ikut di respons', async () => {
    const repository = fakeRepository({ list: vi.fn(async () => [record({ status: 'read' })]) });
    const service = createNotificationsService(repository);

    const page = await service.list(USER, query());

    expect(Object.keys(page.data[0]!).sort()).toEqual(
      ['body', 'channel', 'created_at', 'id', 'scheduled_for', 'sent_at', 'status', 'title', 'type'].sort(),
    );
    expect(page.data[0]).toMatchObject({
      id: NOTIF_ID,
      type: 'daily_summary',
      channel: 'whatsapp',
      status: 'read',
      scheduled_for: null,
      sent_at: SENT_AT.toISOString(),
      created_at: CREATED_AT.toISOString(),
    });
  });

  it('markRead: status read dikembalikan sebagai body snake_case', async () => {
    const repository = fakeRepository({
      markRead: vi.fn(async () => ({ status: 'read' as const, record: record({ status: 'read' }) })),
    });
    const service = createNotificationsService(repository);

    const body = await service.markRead(USER, NOTIF_ID);

    expect(repository.markRead).toHaveBeenCalledWith(USER, NOTIF_ID);
    expect(body.status).toBe('read');
    expect(body.sent_at).toBe(SENT_AT.toISOString());
  });

  it('markRead: baris tidak ada atau milik pengguna lain dijawab 404', async () => {
    const service = createNotificationsService(fakeRepository());

    await expect(service.markRead(USER, NOTIF_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('markRead: status selain sent/read dijawab 409 CONFLICT', async () => {
    const repository = fakeRepository({ markRead: vi.fn(async () => ({ status: 'conflict' as const })) });
    const service = createNotificationsService(repository);

    const error = await service.markRead(USER, NOTIF_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: [{ field: 'status', issue: 'invalid_transition' }],
    });
  });
});
