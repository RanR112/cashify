// Integration test modul audit-logs. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider.
//
// Fokus: hanya baris milik pemanggil, filter entity_type/entity_id, urutan dan paginasi
// dengan created_at identik, item tanpa id/user_id/ip_address, allowlist changes, dan
// penolakan query/cursor yang tidak valid.

import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { auditLogListSchema } from '../../src/modules/audit-logs/audit-logs.schema.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

const testDbUrl = inject('testDbUrl');

const BASE = new Date('2026-10-05T05:00:00.000Z');
const at = (minutes: number): Date => new Date(BASE.getTime() + minutes * 60_000);

interface TestUser {
  id: string;
  email: string;
  token: string;
}

interface SeedOptions {
  entityType?: 'transaction' | 'budget';
  entityId?: string;
  action?: 'create' | 'update' | 'delete' | 'restore';
  actorType?: 'user' | 'system' | 'whatsapp';
  changes?: Prisma.InputJsonValue | null;
  createdAt?: Date;
  ipAddress?: string | null;
}

describe.skipIf(!testDbUrl)('modul audit-logs (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let server: TestServer;
  let a: TestUser;
  let b: TestUser;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetUserData(prisma);
    // audit_logs.user_id ON DELETE SET NULL: baris lama tetap ada setelah pengguna dihapus.
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

  const get = (path: string, user?: TestUser) =>
    fetch(`${server.url}${path}`, {
      headers: user ? { authorization: `Bearer ${user.token}` } : {},
    });

  async function seed(user: TestUser, options: SeedOptions = {}) {
    return prisma.auditLog.create({
      data: {
        userId: user.id,
        entityType: options.entityType ?? 'transaction',
        entityId: options.entityId ?? randomUUID(),
        action: options.action ?? 'update',
        actorType: options.actorType ?? 'user',
        changes: options.changes === undefined ? { after: { amount: 25000 } } : options.changes === null ? Prisma.DbNull : options.changes,
        createdAt: options.createdAt ?? BASE,
        ipAddress: options.ipAddress === undefined ? '203.0.113.7' : options.ipAddress,
      },
    });
  }

  it('401 tanpa token', async () => {
    const res = await get('/audit-logs');
    expect(res.status).toBe(401);
    expect((await readJson(res)).error.code).toBe('UNAUTHORIZED');
  });

  it('hanya menampilkan baris milik pemanggil', async () => {
    const own = await seed(a, { changes: { after: { amount: 25000 } } });
    await seed(b, { changes: { after: { amount: 999000 } } });

    const res = await get('/audit-logs', a);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(auditLogListSchema.safeParse(body).success).toBe(true);
    expect(body.data.map((item: { entity_id: string }) => item.entity_id)).toEqual([own.entityId]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('menyaring entity_type dan entity_id', async () => {
    const tx = await seed(a, { entityType: 'transaction', createdAt: at(-2) });
    const budget = await seed(a, { entityType: 'budget', createdAt: at(-1) });

    const byType = await get('/audit-logs?entity_type=budget', a);
    expect(byType.status).toBe(200);
    expect((await readJson(byType)).data.map((item: { entity_id: string }) => item.entity_id)).toEqual([
      budget.entityId,
    ]);

    const byId = await get(`/audit-logs?entity_id=${tx.entityId}`, a);
    expect(byId.status).toBe(200);
    expect((await readJson(byId)).data.map((item: { entity_id: string }) => item.entity_id)).toEqual([tx.entityId]);

    const both = await get(`/audit-logs?entity_type=budget&entity_id=${tx.entityId}`, a);
    expect(both.status).toBe(200);
    expect((await readJson(both)).data).toEqual([]);
  });

  it('item tidak memuat id, user_id, atau ip_address dan changes disaring allowlist', async () => {
    await seed(a, {
      changes: {
        before: { amount: 1000, ip_address: '203.0.113.7', phone: '+628123456789' },
        after: { amount: 2000, otp: '123456' },
      },
    });

    const res = await get('/audit-logs', a);
    const body = await readJson(res);
    const item = body.data[0];

    expect(Object.keys(item)).toEqual([
      'entity_type',
      'entity_id',
      'action',
      'actor_type',
      'changes',
      'created_at',
    ]);
    expect(item).not.toHaveProperty('id');
    expect(item).not.toHaveProperty('user_id');
    expect(item).not.toHaveProperty('ip_address');
    expect(item.changes).toEqual({ before: { amount: 1000 }, after: { amount: 2000 } });
    expect(JSON.stringify(body)).not.toContain('ip_address');
    expect(JSON.stringify(body)).not.toContain('+628123456789');
    expect(JSON.stringify(body)).not.toContain('123456');
  });

  it('anggaran: categories dipertahankan, kunci asing dibuang', async () => {
    const categories = [{ category_id: randomUUID(), amount: 500000 }];
    await seed(a, {
      entityType: 'budget',
      changes: { after: { name: 'Anggaran Oktober', total_amount: 3000000, categories, auto_renew: true, secret: 'x' } },
    });

    const body = await readJson(await get('/audit-logs?entity_type=budget', a));
    expect(body.data[0].changes).toEqual({
      after: { name: 'Anggaran Oktober', total_amount: 3000000, categories, auto_renew: true },
    });
  });

  it('urut created_at menurun dan id menurun', async () => {
    const old = await seed(a, { entityId: randomUUID(), createdAt: at(-10) });
    const firstAtSameTime = await seed(a, { entityId: randomUUID(), createdAt: at(0) });
    const secondAtSameTime = await seed(a, { entityId: randomUUID(), createdAt: at(0) });

    const body = await readJson(await get('/audit-logs', a));
    expect(body.data.map((item: { entity_id: string }) => item.entity_id)).toEqual([
      secondAtSameTime.entityId,
      firstAtSameTime.entityId,
      old.entityId,
    ]);
  });

  it('paginasi dengan dua baris ber-created_at identik tidak mengulang atau melewatkan baris', async () => {
    const first = await seed(a, { entityId: randomUUID(), createdAt: at(0) });
    const second = await seed(a, { entityId: randomUUID(), createdAt: at(0) });

    const page1 = await readJson(await get('/audit-logs?limit=1', a));
    expect(page1.data.map((item: { entity_id: string }) => item.entity_id)).toEqual([second.entityId]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toEqual(expect.any(String));

    const page2 = await readJson(
      await get(`/audit-logs?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`, a),
    );
    expect(page2.data.map((item: { entity_id: string }) => item.entity_id)).toEqual([first.entityId]);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
  });

  it.each([
    ['entity_type tidak dikenal', '/audit-logs?entity_type=whatsapp_account'],
    ['entity_id bukan UUID', '/audit-logs?entity_id=makanan'],
    ['limit di luar batas', '/audit-logs?limit=0'],
    ['cursor rusak', '/audit-logs?cursor=abc'],
    [
      'cursor dengan id bukan angka',
      `/audit-logs?cursor=${Buffer.from(JSON.stringify({ t: '2026-10-05T05:00:00.000Z', i: 'abc' })).toString('base64url')}`,
    ],
  ])('400 untuk %s', async (_label, path) => {
    const res = await get(path, a);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
  });
});