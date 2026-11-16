// Integration test modul notifications. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider. Bagian worker
// membutuhkan Redis (docker compose up -d redis); dilewati bila Redis tidak menyala.
//
// Fokus: riwayat milik pengguna saja, urutan dan cursor, filter status, payload tidak
// ditampilkan, transisi sent -> read (idempoten, 409 dari pending/failed, 404 milik orang
// lain), penjaga repository (markSent/markFailed hanya dari pending), dan status notifikasi
// pada job outbound tanpa mengubah perilaku job OTP/balasan bot.

import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { createNotificationsRepository } from '../../src/modules/notifications/notifications.repository.js';
import {
  notificationListSchema,
  notificationSchema,
} from '../../src/modules/notifications/notifications.schema.js';
import { createQueues, enqueueOutbound, type Queues } from '../../src/queues/index.js';
import { createInboundPipeline, type InboundPipeline } from '../../src/workers/pipeline.js';
import { startWorkers, type StartedWorkers, type StartWorkersOptions } from '../../src/workers/index.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), fatal: vi.fn() },
}));

const testDbUrl = inject('testDbUrl');
const redisUrl = inject('testRedisUrl');

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const BASE = new Date('2026-10-05T05:00:00.000Z');

interface TestUser {
  id: string;
  email: string;
  token: string;
}

/** Selisih menit supaya setiap baris punya `created_at` yang unik (cursor tidak ambigu). */
const at = (minutes: number): Date => new Date(BASE.getTime() + minutes * 60_000);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timeout menunggu: ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!testDbUrl)('modul notifications (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let server: TestServer;
  let a: TestUser;
  let b: TestUser;
  /** Tanggal unik per baris seed: unique (user_id, type, payload.date) melarang ringkasan dobel. */
  let seedDay = 0;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    seedDay = 0;
    await resetUserData(prisma);
    await prisma.auditLog.deleteMany();
    await prisma.messageLog.deleteMany();
    await ensureSystemCategories(prisma);
    const provider = new FakeAuthProvider(prisma);
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({ authService, prisma, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
    );

    a = await register('ayu@example.com', 'Ayu Penguji');
    b = await register('budi@example.com', 'Budi Korban');
  });

  afterEach(async () => {
    await server.close();
  });

  async function register(email: string, fullName: string): Promise<TestUser> {
    const res = await postJson(`${server.url}/auth/register`, {
      email,
      password: 'rahasia-banget-123',
      full_name: fullName,
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.user.id, email, token: body.session.access_token };
  }

  const call = (method: string, path: string, user?: TestUser) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { ...(user && { authorization: `Bearer ${user.token}` }) },
    });

  interface SeedOptions {
    status?: 'pending' | 'sent' | 'failed' | 'read';
    type?: 'daily_summary' | 'budget_alert';
    title?: string;
    body?: string;
    sentAt?: Date | null;
  }

  async function seed(user: TestUser, createdAt: Date, options: SeedOptions = {}) {
    const status = options.status ?? 'sent';
    // Setiap baris mendapat tanggal kalender berbeda. Riwayat boleh berisi banyak notifikasi,
    // tetapi unique expression index hanya mengizinkan satu daily_summary per (user, tanggal).
    const date = new Date(BASE.getTime() + seedDay * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    seedDay += 1;
    return prisma.notification.create({
      data: {
        userId: user.id,
        type: options.type ?? 'daily_summary',
        channel: 'whatsapp',
        title: options.title ?? 'Ringkasan harian',
        body: options.body ?? 'Masuk: Rp0',
        payload: { date },
        status,
        sentAt: options.sentAt !== undefined ? options.sentAt : status === 'sent' || status === 'read' ? createdAt : null,
        createdAt,
      },
    });
  }

  const statusOf = async (id: string) => (await prisma.notification.findUniqueOrThrow({ where: { id } })).status;

  // ------------------------------------------------------------------
  // GET /notifications
  // ------------------------------------------------------------------

  it('menolak tanpa token', async () => {
    const res = await call('GET', '/notifications');
    expect(res.status).toBe(401);
  });

  it('riwayat kosong dijawab halaman kosong tanpa cursor', async () => {
    const res = await call('GET', '/notifications', a);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(notificationListSchema.parse(body)).toEqual({ data: [], next_cursor: null, has_more: false });
  });

  it('hanya menampilkan notifikasi milik pemanggil, terbaru dulu, tanpa payload', async () => {
    await seed(a, at(0), { title: 'Lama' });
    await seed(a, at(2), { title: 'Baru', type: 'budget_alert' });
    await seed(a, at(1), { title: 'Tengah', status: 'failed' });
    const secret = await seed(b, at(3), { title: 'RAHASIA BUDI' });

    const res = await call('GET', '/notifications', a);
    expect(res.status).toBe(200);
    const body = notificationListSchema.parse(await readJson(res));

    expect(body.data.map((item) => item.title)).toEqual(['Baru', 'Tengah', 'Lama']);
    expect(body.data.map((item) => item.id)).not.toContain(secret.id);
    expect(JSON.stringify(body)).not.toContain('RAHASIA BUDI');
    expect(body.data[0]).not.toHaveProperty('payload');
    expect(body.data[0]).toMatchObject({
      type: 'budget_alert',
      channel: 'whatsapp',
      status: 'sent',
      scheduled_for: null,
      sent_at: at(2).toISOString(),
      created_at: at(2).toISOString(),
    });
  });

  it('menyaring menurut status', async () => {
    await seed(a, at(0), { status: 'sent' });
    await seed(a, at(1), { status: 'pending' });
    await seed(a, at(2), { status: 'failed' });
    await seed(a, at(3), { status: 'read' });

    const body = notificationListSchema.parse(await readJson(await call('GET', '/notifications?status=failed', a)));
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('failed');
  });

  it('paginasi cursor menelusuri semua baris tanpa duplikat atau kehilangan', async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await seed(a, at(i), { title: `Notifikasi ${i + 1}` }));

    const first = notificationListSchema.parse(await readJson(await call('GET', '/notifications?limit=2', a)));
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = notificationListSchema.parse(
      await readJson(await call('GET', `/notifications?limit=2&cursor=${first.next_cursor}`, a)),
    );
    expect(second.has_more).toBe(true);

    const third = notificationListSchema.parse(
      await readJson(await call('GET', `/notifications?limit=2&cursor=${second.next_cursor}`, a)),
    );
    expect(third.data).toHaveLength(1);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();

    const ids = [...first.data, ...second.data, ...third.data].map((item) => item.id);
    expect(ids).toEqual(rows.map((row) => row.id).reverse());
    expect(new Set(ids).size).toBe(5);
  });

  it('menolak status, cursor, dan limit yang tidak valid', async () => {
    for (const path of [
      '/notifications?status=terkirim',
      '/notifications?cursor=bukan-cursor',
      '/notifications?limit=101',
      '/notifications?limit=0',
    ]) {
      const res = await call('GET', path, a);
      expect(res.status, path).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  // ------------------------------------------------------------------
  // PATCH /notifications/{id}/read
  // ------------------------------------------------------------------

  it('sent -> read, mengembalikan 200 dan mempertahankan sent_at', async () => {
    const row = await seed(a, at(0), { status: 'sent', sentAt: at(10) });

    const res = await call('PATCH', `/notifications/${row.id}/read`, a);
    expect(res.status).toBe(200);
    const body = notificationSchema.parse(await readJson(res));
    expect(body.status).toBe('read');
    expect(body.sent_at).toBe(at(10).toISOString());
    expect(body.created_at).toBe(at(0).toISOString());
    expect(await statusOf(row.id)).toBe('read');
  });

  it('idempoten: read yang diulang tetap 200', async () => {
    const row = await seed(a, at(0), { status: 'sent', sentAt: at(10) });

    expect((await call('PATCH', `/notifications/${row.id}/read`, a)).status).toBe(200);
    const again = await call('PATCH', `/notifications/${row.id}/read`, a);
    expect(again.status).toBe(200);
    expect(notificationSchema.parse(await readJson(again)).status).toBe('read');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).sentAt).toEqual(at(10));
  });

  it('pending dan failed tidak boleh menjadi read (409 CONFLICT)', async () => {
    const pending = await seed(a, at(0), { status: 'pending' });
    const failed = await seed(a, at(1), { status: 'failed' });

    for (const row of [pending, failed]) {
      const res = await call('PATCH', `/notifications/${row.id}/read`, a);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details).toEqual([{ field: 'status', issue: 'invalid_transition' }]);
      expect(await statusOf(row.id)).toBe(row.status);
    }
  });

  it('notifikasi milik pengguna lain dijawab 404, bukan 403, dan tidak berubah', async () => {
    const row = await seed(b, at(0), { status: 'sent', sentAt: at(1) });

    const res = await call('PATCH', `/notifications/${row.id}/read`, a);
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('NOT_FOUND');
    expect(await statusOf(row.id)).toBe('sent');
  });

  it('id yang tidak ada dijawab 404, id bukan UUID dijawab 400', async () => {
    const missing = await call('PATCH', `/notifications/${UNKNOWN_ID}/read`, a);
    expect(missing.status).toBe(404);

    const invalid = await call('PATCH', '/notifications/bukan-uuid/read', a);
    expect(invalid.status).toBe(400);
    expect((await readJson(invalid)).error.code).toBe('VALIDATION_ERROR');
  });

  // ------------------------------------------------------------------
  // Penjaga repository (jalur worker, tanpa HTTP)
  // ------------------------------------------------------------------

  describe('repository: transisi status hanya dari pending', () => {
    it('markSent mengisi sent_at sekali saja', async () => {
      const repository = createNotificationsRepository(prisma);
      const { id } = await repository.createPending(a.id, {
        type: 'daily_summary',
        title: 'Ringkasan harian',
        body: 'Masuk: Rp0',
        payload: { date: '2026-10-05' },
      });

      expect(await repository.markSent(id)).toBe(true);
      const afterSent = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(afterSent.status).toBe('sent');
      expect(afterSent.sentAt).not.toBeNull();
      expect(afterSent.channel).toBe('whatsapp');

      expect(await repository.markSent(id)).toBe(false);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).sentAt).toEqual(afterSent.sentAt);
    });

    it('markFailed hanya mengubah baris pending, dan tidak menyentuh sent_at', async () => {
      const repository = createNotificationsRepository(prisma);
      const { id: pending } = await repository.createPending(a.id, {
        type: 'budget_alert',
        title: 'Peringatan anggaran',
        body: 'Isi',
        payload: { budget_id: UNKNOWN_ID },
      });

      expect(await repository.markFailed(pending)).toBe(true);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: pending } })).status).toBe('failed');

      const sent = await seed(a, at(0), { status: 'sent' });
      expect(await repository.markFailed(sent.id)).toBe(false);
      expect(await statusOf(sent.id)).toBe('sent');
    });
  });

  // ------------------------------------------------------------------
  // Worker outbound (butuh Redis)
  // ------------------------------------------------------------------

  describe.skipIf(!redisUrl)('worker outbound (integrasi, Redis + BullMQ)', () => {
    let connection: Redis;
    let helperRedis: Redis;
    let queues: Queues;
    let workers: StartedWorkers | undefined;
    let pipeline: InboundPipeline;
    let prefix: string;

    beforeEach(() => {
      prefix = `test-${randomUUID()}`;
      connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      helperRedis = new Redis(redisUrl);
      queues = createQueues(connection, { prefix });
      // Port status notifikasi dirakit composition root worker, sama seperti src/worker.ts.
      pipeline = createInboundPipeline({ prisma, redis: helperRedis, enqueueReply: async () => undefined });
    });

    afterEach(async () => {
      await workers?.close();
      workers = undefined;
      await Promise.all([queues.inbound.obliterate({ force: true }), queues.outbound.obliterate({ force: true })]);
      await Promise.all([queues.inbound.close(), queues.outbound.close()]);
      await helperRedis.quit();
      await connection.quit();
    });

    async function setup(options: Omit<StartWorkersOptions, 'prefix'>): Promise<void> {
      workers = startWorkers(connection, { ...options, prefix });
      await workers.ready();
    }

    it('job dengan notification_id: pesan terkirim lalu status menjadi sent', async () => {
      const row = await seed(a, at(0), { status: 'pending' });
      const send = vi.fn(async () => undefined);

      await setup({
        outbound: { send, pause: async () => undefined, notifications: pipeline.notificationStatus },
      });
      await enqueueOutbound(queues.outbound, { wa_chat_id: '628@c.us', text: 'halo', notification_id: row.id });

      await waitFor(async () => (await statusOf(row.id)) === 'sent', 10_000, 'status sent');
      expect(send).toHaveBeenCalledTimes(1);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).sentAt).not.toBeNull();
    });

    it('job tanpa notification_id tetap berjalan seperti sebelumnya (OTP, balasan bot)', async () => {
      const send = vi.fn(async () => undefined);

      await setup({
        outbound: { send, pause: async () => undefined, notifications: pipeline.notificationStatus },
      });
      await enqueueOutbound(queues.outbound, { wa_chat_id: '628@c.us', text: 'kode OTP: 123456' });

      await waitFor(() => send.mock.calls.length === 1, 10_000, 'pengiriman tanpa notification_id');
      // Tidak ada baris notifikasi yang dibuat atau disentuh.
      expect(await prisma.notification.count()).toBe(0);
    });

    it('percobaan habis: status menjadi failed, bukan menggantung pending', async () => {
      const row = await seed(a, at(0), { status: 'pending' });
      const send = vi.fn(async () => {
        throw new Error('gateway menolak');
      });

      await setup({
        outbound: { send, pause: async () => undefined, notifications: pipeline.notificationStatus },
      });
      // attempts: 1 membuat kegagalan pertama langsung final, tanpa menunggu backoff 5 detik.
      await queues.outbound.add(
        'send-message',
        { wa_chat_id: '628@c.us', text: 'halo', notification_id: row.id },
        { attempts: 1 },
      );

      await waitFor(async () => (await statusOf(row.id)) === 'failed', 10_000, 'status failed setelah percobaan habis');
      expect(send).toHaveBeenCalledTimes(1);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).sentAt).toBeNull();
    });

    it('data job rusak tetap menandai failed: notification_id dibaca lenient', async () => {
      const row = await seed(a, at(0), { status: 'pending' });
      const send = vi.fn(async () => undefined);

      await setup({
        outbound: { send, pause: async () => undefined, notifications: pipeline.notificationStatus },
      });
      // wa_chat_id kosong menggagalkan outboundJobSchema sebelum ada pengiriman.
      await queues.outbound.add(
        'send-message',
        { wa_chat_id: '', text: 'halo', notification_id: row.id },
        { attempts: 1 },
      );

      await waitFor(async () => (await statusOf(row.id)) === 'failed', 10_000, 'status failed untuk data rusak');
      expect(send).not.toHaveBeenCalled();
    });

    it('job kedaluwarsa: tidak dikirim dan status menjadi failed, bukan menggantung pending', async () => {
      const row = await seed(a, at(0), { status: 'pending' });
      const send = vi.fn(async () => undefined);

      await setup({
        outbound: {
          send,
          pause: async () => undefined,
          maxAgeMs: -1, // dijamin lebih tua dari batas, tanpa menunggu satu jam
          notifications: pipeline.notificationStatus,
        },
      });
      await enqueueOutbound(queues.outbound, { wa_chat_id: '628@c.us', text: 'halo', notification_id: row.id });

      await waitFor(async () => (await statusOf(row.id)) === 'failed', 10_000, 'status failed');
      expect(send).not.toHaveBeenCalled();
    });
  });
});
