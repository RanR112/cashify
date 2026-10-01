// Integration test modul users, accounts, categories, dengan fokus isolasi antar-pengguna.
// Express nyata + Prisma nyata ke Postgres test (docker compose up -d postgres-test); Supabase
// diganti FakeAuthProvider. Dilewati bila Postgres test tidak menyala.
//
// Dua pengguna: A (penguji) dan B (korban). Setiap test mencoba membaca atau mengubah data B
// dengan token A, lewat body, query, header, dan path. Data B diberi nama khas supaya
// kebocoran sekecil apa pun terlihat di respons.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { userProfileSchema } from '../../src/shared/schemas/user.schema.js';
import { postJson, readJson, startServer, type JsonBody, type TestServer } from '../helpers/http.js';
import {
  createTestPrisma,
  ensureSystemCategories,
  FakeAuthProvider,
  resetUserData,
  SYSTEM_CATEGORY_COUNT,
} from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

interface TestUser {
  id: string;
  email: string;
  fullName: string;
  token: string;
}

describe.skipIf(!testDbUrl)('modul users, accounts, categories (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;
  let server: TestServer;
  let a: TestUser;
  let b: TestUser;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function register(email: string, fullName: string, initialBalance: number): Promise<TestUser> {
    const res = await postJson(`${server.url}/auth/register`, {
      email,
      password: 'rahasia-banget-123',
      full_name: fullName,
      initial_balance: initialBalance,
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.user.id, email, fullName, token: body.session.access_token };
  }

  beforeEach(async () => {
    await resetUserData(prisma);
    await ensureSystemCategories(prisma);
    provider = new FakeAuthProvider(prisma);
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({ authService, prisma, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
    );

    a = await register('ayu@example.com', 'Ayu Penguji', 1_000_000);
    b = await register('budi@example.com', 'Budi Korban', 7_777_777);

    // Data khas milik B: akun aktif, akun terhapus, kategori kustom aktif dan terhapus.
    await prisma.account.create({ data: { userId: b.id, name: 'Rekening-Rahasia-B', type: 'bank' } });
    await prisma.account.create({
      data: { userId: b.id, name: 'Akun-Terhapus-B', type: 'ewallet', deletedAt: new Date() },
    });
    await prisma.category.create({
      data: { userId: b.id, name: 'Kategori-Rahasia-B', slug: 'rahasia-b', type: 'expense', icon: 'lock', color: '#000001', keywords: [] },
    });
    await prisma.category.create({
      data: {
        userId: b.id,
        name: 'Kategori-Terhapus-B',
        slug: 'terhapus-b',
        type: 'expense',
        icon: 'lock',
        color: '#000002',
        keywords: [],
        deletedAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const get = (path: string, user?: TestUser, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, {
      headers: { ...(user && { authorization: `Bearer ${user.token}` }), ...headers },
    });

  const patch = (body: unknown, user: TestUser) =>
    fetch(`${server.url}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
      body: JSON.stringify(body),
    });

  /** Seluruh teks respons: kebocoran di field mana pun ikut tertangkap. */
  const textOf = async (res: Response) => JSON.stringify(await readJson(res));

  describe('autentikasi', () => {
    it.each([
      ['GET /me', '/me'],
      ['GET /accounts', '/accounts'],
      ['GET /categories', '/categories'],
    ])('%s: 401 tanpa token dan dengan token ngawur', async (_name, path) => {
      const missing = await get(path);
      expect(missing.status).toBe(401);
      expect((await readJson(missing)).error.code).toBe('UNAUTHORIZED');
      expect((await get(path, { ...a, token: 'ngawur' })).status).toBe(401);
    });

    it('PATCH /me: 401 tanpa token', async () => {
      const res = await fetch(`${server.url}/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ full_name: 'Penyusup' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /me', () => {
    it('200: tiap pengguna melihat profilnya sendiri, sesuai kontrak', async () => {
      const resA = await get('/me', a);
      expect(resA.status).toBe(200);
      const bodyA = userProfileSchema.parse(await readJson(resA));
      expect(bodyA).toMatchObject({ id: a.id, email: a.email, full_name: 'Ayu Penguji', initial_balance: 1_000_000 });

      const bodyB = userProfileSchema.parse(await readJson(await get('/me', b)));
      expect(bodyB).toMatchObject({ id: b.id, email: b.email, full_name: 'Budi Korban', initial_balance: 7_777_777 });
    });

    it.each([
      ['query user_id', (u: TestUser) => `/me?user_id=${u.id}`, {}],
      ['query userId', (u: TestUser) => `/me?userId=${u.id}`, {}],
      ['query id', (u: TestUser) => `/me?id=${u.id}`, {}],
      ['header X-User-Id', () => '/me', (u: TestUser) => ({ 'x-user-id': u.id })],
    ])('%s milik B diabaikan: tetap profil A', async (_name, path, headers) => {
      const res = await get(path(b), a, typeof headers === 'function' ? headers(b) : headers);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.id).toBe(a.id);
      expect(JSON.stringify(body)).not.toContain('Budi');
    });

    it('/me/<id B> tidak ada rute: 404', async () => {
      expect((await get(`/me/${b.id}`, a)).status).toBe(404);
    });

    it('404 bila akun pemilik token sudah di-soft-delete', async () => {
      await prisma.user.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
      const res = await get('/me', a);
      expect(res.status).toBe(404);
      expect((await readJson(res)).error.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /me', () => {
    it('200: mengubah sebagian field, sisanya tetap', async () => {
      const res = await patch({ full_name: 'Ayu Baru', initial_balance: 2_500_000 }, a);
      expect(res.status).toBe(200);
      const body = userProfileSchema.parse(await readJson(res));
      expect(body).toMatchObject({ id: a.id, full_name: 'Ayu Baru', initial_balance: 2_500_000, avatar_url: null });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(row).toMatchObject({ fullName: 'Ayu Baru', initialBalance: 2_500_000 });
    });

    it('avatar bisa diisi lalu dihapus dengan null', async () => {
      const set = await readJson(await patch({ avatar_url: 'https://example.com/a.png' }, a));
      expect(set.avatar_url).toBe('https://example.com/a.png');
      const cleared = await readJson(await patch({ avatar_url: null }, a));
      expect(cleared.avatar_url).toBeNull();
    });

    it.each([
      ['body kosong', {}],
      ['saldo desimal', { initial_balance: 2500000.75 }],
      ['saldo negatif', { initial_balance: -1 }],
      ['saldo melebihi Int32', { initial_balance: 2_147_483_648 }],
      ['nama terlalu pendek', { full_name: 'D' }],
      ['avatar bukan URL', { avatar_url: 'bukan-url' }],
    ])('400 untuk %s, dan database tidak berubah', async (_name, body) => {
      const res = await patch(body, a);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(row).toMatchObject({ fullName: 'Ayu Penguji', initialBalance: 1_000_000 });
    });

    it('user_id dan id milik B di body diabaikan: hanya A yang berubah, B utuh', async () => {
      const res = await patch({ user_id: b.id, id: b.id, userId: b.id, full_name: 'Dibajak', initial_balance: 1 }, a);
      expect(res.status).toBe(200);
      expect((await readJson(res)).id).toBe(a.id);

      expect(await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
        fullName: 'Dibajak',
        initialBalance: 1,
      });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
        fullName: 'Budi Korban',
        initialBalance: 7_777_777,
      });
    });

    it('?user_id=B pada PATCH diabaikan: hanya A yang berubah', async () => {
      const res = await fetch(`${server.url}/me?user_id=${b.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, 'x-user-id': b.id },
        body: JSON.stringify({ full_name: 'Lewat Query' }),
      });
      expect(res.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).fullName).toBe('Lewat Query');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).fullName).toBe('Budi Korban');
    });

    it('404 dan tidak mengubah apa pun bila akun pemilik token sudah di-soft-delete', async () => {
      await prisma.user.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
      const res = await patch({ full_name: 'Hantu' }, a);
      expect(res.status).toBe(404);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.id } })).fullName).toBe('Ayu Penguji');
    });
  });

  describe('GET /accounts', () => {
    it('200: hanya akun milik pemanggil, sesuai kontrak', async () => {
      const res = await get('/accounts', a);
      expect(res.status).toBe(200);
      const { data } = await readJson(res);
      expect(data).toHaveLength(1);
      expect(data[0]).toEqual({ id: expect.any(String), name: 'Tunai', type: 'cash', is_default: true });
      const ownAccount = await prisma.account.findFirstOrThrow({ where: { userId: a.id } });
      expect(data[0].id).toBe(ownAccount.id);
    });

    it('akun B (aktif maupun terhapus) tidak pernah muncul di A, dan sebaliknya', async () => {
      const forA = await textOf(await get('/accounts', a));
      expect(forA).not.toContain('Rahasia-B');
      expect(forA).not.toContain('Terhapus-B');

      const { data } = await readJson(await get('/accounts', b));
      // Tunai + Rekening-Rahasia-B; akun terhapus tidak tampil bahkan untuk pemiliknya.
      expect(data.map((account: JsonBody) => account.name).sort()).toEqual(['Rekening-Rahasia-B', 'Tunai']);
    });

    it('akun default tampil lebih dulu', async () => {
      const { data } = await readJson(await get('/accounts', b));
      expect(data[0].is_default).toBe(true);
    });

    it.each([
      ['user_id', (u: TestUser) => `/accounts?user_id=${u.id}`],
      ['userId', (u: TestUser) => `/accounts?userId=${u.id}`],
      ['dua-duanya', (u: TestUser) => `/accounts?user_id=${u.id}&userId=${u.id}`],
      ['user_id array', (u: TestUser) => `/accounts?user_id[]=${u.id}`],
      ['user_id ala SQL', () => `/accounts?user_id=${encodeURIComponent("' OR '1'='1")}`],
    ])('query %s milik B diabaikan', async (_name, path) => {
      const res = await get(path(b), a, { 'x-user-id': b.id });
      expect(res.status).toBe(200);
      const text = await textOf(res);
      expect(text).not.toContain('Rahasia-B');
      expect(JSON.parse(text).data).toHaveLength(1);
    });
  });

  describe('GET /categories', () => {
    it('pengguna baru: 12 kategori (7 pengeluaran, 5 pemasukan), tanpa nama kembar', async () => {
      const res = await get('/categories', a);
      expect(res.status).toBe(200);
      const { data } = await readJson(res);

      expect(data).toHaveLength(SYSTEM_CATEGORY_COUNT);
      // Nama boleh sama lintas tipe (seed punya "Lainnya" di pengeluaran dan pemasukan); kembar = tipe + nama sama.
      const keys = data.map((category: JsonBody) => `${category.type}:${category.name}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(data.filter((category: JsonBody) => category.type === 'expense')).toHaveLength(7);
      expect(data.filter((category: JsonBody) => category.type === 'income')).toHaveLength(5);
      for (const category of data) {
        expect(Object.keys(category).sort()).toEqual(['color', 'icon', 'id', 'is_system', 'name', 'type']);
      }
    });

    it('baris yang dikembalikan adalah salinan milik pengguna (is_system false), bukan baris sistem ganda', async () => {
      const { data } = await readJson(await get('/categories', a));
      const ownIds = (await prisma.category.findMany({ where: { userId: a.id }, select: { id: true } })).map((c) => c.id);
      expect(data.map((category: JsonBody) => category.id).sort()).toEqual(ownIds.sort());
      expect(data.every((category: JsonBody) => category.is_system === false)).toBe(true);
    });

    it('pengguna tanpa salinan tetap melihat kategori sistem (is_system true)', async () => {
      await prisma.category.deleteMany({ where: { userId: a.id } });
      const { data } = await readJson(await get('/categories', a));
      expect(data).toHaveLength(SYSTEM_CATEGORY_COUNT);
      expect(data.every((category: JsonBody) => category.is_system === true)).toBe(true);
    });

    it('kategori kustom B tidak muncul di A; milik B muncul di B; yang terhapus tidak muncul di siapa pun', async () => {
      const forA = await textOf(await get('/categories', a));
      expect(forA).not.toContain('Rahasia-B');
      expect(forA).not.toContain('Terhapus-B');

      const forB = (await readJson(await get('/categories', b))).data as JsonBody[];
      expect(forB.map((category) => category.name)).toContain('Kategori-Rahasia-B');
      expect(forB.map((category) => category.name)).not.toContain('Kategori-Terhapus-B');
      expect(forB).toHaveLength(SYSTEM_CATEGORY_COUNT + 1);
    });

    it('kategori kustom A tidak bocor ke B', async () => {
      await prisma.category.create({
        data: { userId: a.id, name: 'Kategori-Rahasia-A', slug: 'rahasia-a', type: 'income', icon: 'lock', color: '#000003', keywords: [] },
      });
      expect(await textOf(await get('/categories', b))).not.toContain('Rahasia-A');
      expect(await textOf(await get('/categories', a))).toContain('Rahasia-A');
    });

    it('kategori sistem asli (user_id NULL) tetap ada di database walau tidak ikut ditampilkan', async () => {
      expect(await prisma.category.count({ where: { userId: null } })).toBe(SYSTEM_CATEGORY_COUNT);
    });

    it('?type=expense menyaring tipe tanpa keluar dari batas pemilik', async () => {
      const forA = await get('/categories?type=expense', a);
      expect(forA.status).toBe(200);
      const dataA = (await readJson(forA)).data as JsonBody[];
      expect(dataA).toHaveLength(7);
      expect(dataA.every((category) => category.type === 'expense')).toBe(true);
      expect(JSON.stringify(dataA)).not.toContain('Rahasia-B');

      // B punya satu kategori kustom bertipe expense: hanya B yang melihatnya.
      const dataB = (await readJson(await get('/categories?type=expense', b))).data as JsonBody[];
      expect(dataB).toHaveLength(8);
    });

    it('?type=income tidak memuat kategori kustom B yang bertipe expense', async () => {
      const dataB = (await readJson(await get('/categories?type=income', b))).data as JsonBody[];
      expect(dataB).toHaveLength(5);
    });

    it.each([
      ['type tidak dikenal', '/categories?type=transfer'],
      ['type berulang', '/categories?type=expense&type=income'],
      ['type ala SQL', `/categories?type=${encodeURIComponent("expense' OR user_id IS NOT NULL --")}`],
    ])('400 untuk %s', async (_name, path) => {
      const res = await get(path, a);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['user_id', (u: TestUser) => `/categories?user_id=${u.id}`, SYSTEM_CATEGORY_COUNT],
      ['userId + type', (u: TestUser) => `/categories?type=expense&userId=${u.id}`, 7],
      ['user_id=null', () => '/categories?user_id=null', SYSTEM_CATEGORY_COUNT],
      // Parser query Express 5 membaca `type[]` sebagai kunci literal, bukan `type`: dibuang, tanpa filter.
      ['type[] (kunci literal)', () => '/categories?type[]=expense', SYSTEM_CATEGORY_COUNT],
    ])('query %s milik B diabaikan', async (_name, path, expectedCount) => {
      const res = await get(path(b), a, { 'x-user-id': b.id });
      expect(res.status).toBe(200);
      const text = await textOf(res);
      expect(text).not.toContain('Rahasia-B');
      expect(JSON.parse(text).data).toHaveLength(expectedCount);
    });
  });
});
