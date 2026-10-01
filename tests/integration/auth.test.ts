// Integration test modul auth: Express nyata + Prisma nyata ke Postgres test (docker compose
// up -d postgres-test). Supabase Auth dan Google diganti FakeAuthProvider; tidak ada panggilan
// jaringan keluar. Dilewati bila Postgres test tidak menyala.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService, FORGOT_PASSWORD_MESSAGE } from '../../src/modules/auth/auth.service.js';
import { authResultSchema, sessionSchema } from '../../src/shared/schemas/user.schema.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';
import {
  createTestPrisma,
  ensureSystemCategories,
  FakeAuthProvider,
  resetUserData,
  SYSTEM_CATEGORY_COUNT,
} from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

describe.skipIf(!testDbUrl)('modul auth (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;
  let server: TestServer;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // App baru per test: rate limiter in-memory ikut baru, jadi batas login tidak bocor antar-test.
  beforeEach(async () => {
    await resetUserData(prisma);
    await ensureSystemCategories(prisma);
    provider = new FakeAuthProvider(prisma);
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({ authService, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
    );
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown, headers?: Record<string, string>) =>
    postJson(`${server.url}${path}`, body, headers);

  const registerBody = (overrides: Record<string, unknown> = {}) => ({
    email: 'dey@example.com',
    password: 'rahasia-banget-123',
    full_name: 'Dey',
    initial_balance: 2350000,
    ...overrides,
  });

  /** Jumlah baris milik pengguna: users, accounts, kategori salinan. */
  async function countsFor(userId: string) {
    const [users, accounts, categories] = await Promise.all([
      prisma.user.count({ where: { id: userId } }),
      prisma.account.count({ where: { userId } }),
      prisma.category.count({ where: { userId } }),
    ]);
    return { users, accounts, categories };
  }

  const totals = async () => ({
    users: await prisma.user.count(),
    accounts: await prisma.account.count(),
    userCategories: await prisma.category.count({ where: { userId: { not: null } } }),
    authUsers: Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM auth.users`)[0]?.n ?? 0),
  });

  describe('POST /auth/register', () => {
    it('201: membuat users, akun Tunai default, dan salinan kategori sistem; respons sesuai kontrak', async () => {
      const res = await post('/auth/register', registerBody());
      expect(res.status).toBe(201);
      const body = await readJson(res);
      authResultSchema.parse(body);

      expect(body.user.email).toBe('dey@example.com');
      expect(body.user.full_name).toBe('Dey');
      expect(body.user.initial_balance).toBe(2350000);
      expect(body.session.token_type).toBe('bearer');

      const userId = body.user.id as string;
      expect(await countsFor(userId)).toEqual({ users: 1, accounts: 1, categories: SYSTEM_CATEGORY_COUNT });

      const account = await prisma.account.findFirstOrThrow({ where: { userId } });
      expect(account).toMatchObject({ name: 'Tunai', type: 'cash', isDefault: true });
      // Kategori sistem asli tidak berubah (disalin, bukan dipindah).
      expect(await prisma.category.count({ where: { userId: null } })).toBe(SYSTEM_CATEGORY_COUNT);
    });

    it('initial_balance opsional, bawaan 0', async () => {
      const res = await post('/auth/register', { email: 'a@example.com', password: 'rahasia-banget-123', full_name: 'Ayu' });
      expect(res.status).toBe(201);
      expect((await readJson(res)).user.initial_balance).toBe(0);
    });

    it('409 bila email sudah terdaftar, dan tidak meninggalkan baris baru', async () => {
      expect((await post('/auth/register', registerBody())).status).toBe(201);
      const before = await totals();

      const res = await post('/auth/register', registerBody({ full_name: 'Orang Lain' }));
      expect(res.status).toBe(409);
      expect((await readJson(res)).error.code).toBe('CONFLICT');
      expect(await totals()).toEqual(before);
    });

    // Satu test per kasus: pembatas register (3 per jam) menghitung permintaan yang gagal validasi
    // juga, dan setiap test mendapat app baru.
    it.each([
      ['email tidak sah', { email: 'bukan-email' }],
      ['password kurang dari 8 karakter', { password: 'pendek' }],
      ['nama terlalu pendek', { full_name: 'D' }],
      ['saldo awal desimal', { initial_balance: 2350000.5 }],
      ['saldo awal negatif', { initial_balance: -1 }],
      ['saldo awal melebihi Int32', { initial_balance: 2_147_483_648 }],
    ])('400 untuk %s, tanpa menyentuh Supabase maupun database', async (_name, overrides) => {
      const res = await post('/auth/register', registerBody(overrides));
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      expect(provider.users.size).toBe(0);
      expect(await totals()).toEqual({ users: 0, accounts: 0, userCategories: 0, authUsers: 0 });
    });

    it('gagal di tengah transaksi: tidak ada baris users yatim, dan akun Supabase dibersihkan', async () => {
      // Kategori sistem kosong membuat langkah ketiga gagal, setelah users dan accounts terisi.
      await prisma.category.deleteMany({ where: { userId: null } });

      const res = await post('/auth/register', registerBody());
      expect(res.status).toBe(500);
      expect((await readJson(res)).error.code).toBe('INTERNAL_ERROR');

      expect(await totals()).toEqual({ users: 0, accounts: 0, userCategories: 0, authUsers: 0 });
      expect(provider.deletedUserIds).toHaveLength(1);
      expect(provider.users.size).toBe(0);
    });

    it('gagal di tengah transaksi dan pembersihan Supabase juga gagal: tetap tanpa baris yatim di database', async () => {
      await prisma.category.deleteMany({ where: { userId: null } });
      provider.failDeleteUser = true;

      const res = await post('/auth/register', registerBody());
      expect(res.status).toBe(500); // kegagalan aslinya yang sampai ke klien, bukan kegagalan pembersihan

      // users/accounts/categories dibatalkan transaksi; hanya baris auth.users yang tertinggal.
      expect(await totals()).toEqual({ users: 0, accounts: 0, userCategories: 0, authUsers: 1 });
    });

    it('konfirmasi email menyala (tanpa sesi): gagal dengan jelas dan tidak meninggalkan apa pun', async () => {
      provider.requireEmailConfirmation = true;
      const res = await post('/auth/register', registerBody());
      expect(res.status).toBe(500);
      expect(await totals()).toEqual({ users: 0, accounts: 0, userCategories: 0, authUsers: 0 });
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      expect((await post('/auth/register', registerBody())).status).toBe(201);
    });

    it('200: sesi dan profil; tidak membuat baris baru', async () => {
      const before = await totals();
      const res = await post('/auth/login', { email: 'dey@example.com', password: 'rahasia-banget-123' });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      authResultSchema.parse(body);
      expect(body.user.initial_balance).toBe(2350000);
      expect(await totals()).toEqual(before);
    });

    it('401 untuk password salah dan email tak dikenal, dengan pesan yang sama', async () => {
      const wrongPassword = await post('/auth/login', { email: 'dey@example.com', password: 'salah-total' });
      const unknownEmail = await post('/auth/login', { email: 'hantu@example.com', password: 'apa-saja-123' });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect((await readJson(wrongPassword)).error.message).toBe((await readJson(unknownEmail)).error.message);
    });

    it('400 untuk body kosong', async () => {
      const res = await post('/auth/login', {});
      expect(res.status).toBe(400);
    });

    it('pengguna Supabase yang belum punya baris users (provisioning lama gagal) diprovision tepat sekali', async () => {
      const { id } = (await prisma.user.findFirstOrThrow()) as { id: string };
      // Meniru sisa kegagalan lama: hapus baris public tanpa menghapus akun Supabase.
      await prisma.user.delete({ where: { id } });
      expect(await countsFor(id)).toEqual({ users: 0, accounts: 0, categories: 0 });

      for (let i = 0; i < 2; i += 1) {
        const res = await post('/auth/login', { email: 'dey@example.com', password: 'rahasia-banget-123' });
        expect(res.status).toBe(200);
      }
      expect(await countsFor(id)).toEqual({ users: 1, accounts: 1, categories: SYSTEM_CATEGORY_COUNT });
    });

    it('akun yang sudah di-soft-delete ditolak dengan 401', async () => {
      await prisma.user.updateMany({ data: { deletedAt: new Date() } });
      const res = await post('/auth/login', { email: 'dey@example.com', password: 'rahasia-banget-123' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/google', () => {
    const TOKEN = 'google-id-token-dey';

    beforeEach(() => {
      provider.addGoogleToken(TOKEN, {
        email: 'dey.google@example.com',
        name: 'Dey Google',
        picture: 'https://lh3.googleusercontent.com/a/foto',
      });
    });

    it('login pertama membuat users + akun Tunai + salinan kategori, saldo awal 0', async () => {
      const res = await post('/auth/google', { id_token: TOKEN });
      expect(res.status).toBe(200);
      const body = await readJson(res);
      authResultSchema.parse(body);

      expect(body.user).toMatchObject({
        email: 'dey.google@example.com',
        full_name: 'Dey Google',
        avatar_url: 'https://lh3.googleusercontent.com/a/foto',
        initial_balance: 0,
      });
      expect(await countsFor(body.user.id)).toEqual({ users: 1, accounts: 1, categories: SYSTEM_CATEGORY_COUNT });
    });

    it('login kedua (pengguna sama) tidak menduplikasi users, akun, maupun kategori', async () => {
      const first = await readJson(await post('/auth/google', { id_token: TOKEN }));
      const afterFirst = await totals();

      const secondRes = await post('/auth/google', { id_token: TOKEN });
      expect(secondRes.status).toBe(200);
      const second = await readJson(secondRes);

      expect(second.user.id).toBe(first.user.id);
      expect(await totals()).toEqual(afterFirst);
      expect(await countsFor(first.user.id)).toEqual({ users: 1, accounts: 1, categories: SYSTEM_CATEGORY_COUNT });
    });

    it('dua login pertama yang bersamaan tetap menghasilkan satu set data', async () => {
      const [a, b] = await Promise.all([
        post('/auth/google', { id_token: TOKEN }),
        post('/auth/google', { id_token: TOKEN }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const [bodyA, bodyB] = [await readJson(a), await readJson(b)];
      expect(bodyA.user.id).toBe(bodyB.user.id);
      expect(await totals()).toEqual({
        users: 1,
        accounts: 1,
        userCategories: SYSTEM_CATEGORY_COUNT,
        authUsers: 1,
      });
    });

    it('nama Google kosong atau satu huruf: jatuh ke bagian lokal email, bukan gagal di validasi kolom', async () => {
      provider.addGoogleToken('tanpa-nama', { email: 'budi.santoso@example.com' });
      provider.addGoogleToken('nama-pendek', { email: 'siti@example.com', name: 'S' });

      expect((await readJson(await post('/auth/google', { id_token: 'tanpa-nama' }))).user.full_name).toBe('budi.santoso');
      expect((await readJson(await post('/auth/google', { id_token: 'nama-pendek' }))).user.full_name).toBe('siti');
    });

    it('401 untuk token yang ditolak, tanpa membuat apa pun', async () => {
      const res = await post('/auth/google', { id_token: 'token-ngawur' });
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('UNAUTHORIZED');
      expect(await totals()).toEqual({ users: 0, accounts: 0, userCategories: 0, authUsers: 0 });
    });

    it('400 untuk id_token kosong atau hilang', async () => {
      expect((await post('/auth/google', { id_token: '' })).status).toBe(400);
      expect((await post('/auth/google', {})).status).toBe(400);
    });

    describe('email yang sama sudah terdaftar lewat password', () => {
      beforeEach(async () => {
        provider.addGoogleToken('google-email-sama', { email: 'dey@example.com', name: 'Dey G' });
        expect((await post('/auth/register', registerBody())).status).toBe(201);
      });

      it('manual linking mati (Supabase menolak): 409 berpesan jelas, bukan 500', async () => {
        provider.linkingPolicy = 'reject';
        const before = await totals();

        const res = await post('/auth/google', { id_token: 'google-email-sama' });
        expect(res.status).toBe(409);
        const body = await readJson(res);
        expect(body.error.code).toBe('CONFLICT');
        expect(body.error.message).toMatch(/sudah terdaftar dengan metode masuk lain/);
        expect(await totals()).toEqual(before);
      });

      it('Supabase menautkan identitas: masuk ke akun yang sama tanpa menduplikasi data', async () => {
        provider.linkingPolicy = 'link';
        const registered = await prisma.user.findFirstOrThrow();
        const before = await totals();

        const res = await post('/auth/google', { id_token: 'google-email-sama' });
        expect(res.status).toBe(200);
        expect((await readJson(res)).user.id).toBe(registered.id);
        expect(await totals()).toEqual(before);
        // Data dari register (saldo awal) tidak tertimpa metadata Google.
        expect((await prisma.user.findUniqueOrThrow({ where: { id: registered.id } })).initialBalance).toBe(2350000);
      });
    });

    it('sebaliknya: akun Google lalu login password dengan email yang sama menghasilkan 401 yang jelas', async () => {
      await post('/auth/google', { id_token: TOKEN });
      const res = await post('/auth/login', { email: 'dey.google@example.com', password: 'tebakan-123' });
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.message).toMatch(/Google/);
    });
  });

  describe('rate limit login dan Google dihitung bersama', () => {
    it('5 percobaan campuran lolos, yang ke-6 (login atau Google) mendapat 429', async () => {
      provider.addGoogleToken('g', { email: 'g@example.com', name: 'Gina' });
      const attempts = [
        () => post('/auth/login', { email: 'x@example.com', password: 'salah-semua' }),
        () => post('/auth/google', { id_token: 'g' }),
        () => post('/auth/login', { email: 'x@example.com', password: 'salah-semua' }),
        () => post('/auth/google', { id_token: 'g' }),
        () => post('/auth/login', { email: 'x@example.com', password: 'salah-semua' }),
      ];
      for (const attempt of attempts) expect((await attempt()).status).not.toBe(429);

      const sixth = await post('/auth/google', { id_token: 'g' });
      expect(sixth.status).toBe(429);
      const body = await readJson(sixth);
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(sixth.headers.get('retry-after')).not.toBeNull();

      // Dari sisi login pun sama: kuotanya sudah habis.
      expect((await post('/auth/login', { email: 'x@example.com', password: 'salah-semua' })).status).toBe(429);
    });

    it('register punya batas sendiri: 3 per jam per IP', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await post('/auth/register', registerBody({ email: `u${i}@example.com` }));
        expect(res.status).toBe(201);
      }
      expect((await post('/auth/register', registerBody({ email: 'u3@example.com' }))).status).toBe(429);
    });
  });

  describe('POST /auth/refresh', () => {
    it('200: sesi baru; refresh token lama tidak berlaku lagi (rotasi)', async () => {
      const { session } = await readJson(await post('/auth/register', registerBody()));

      const res = await post('/auth/refresh', { refresh_token: session.refresh_token });
      expect(res.status).toBe(200);
      sessionSchema.parse((await readJson(res)).session);

      const reused = await post('/auth/refresh', { refresh_token: session.refresh_token });
      expect(reused.status).toBe(401);
    });

    it('401 untuk token tidak dikenal, 400 untuk token kosong', async () => {
      expect((await post('/auth/refresh', { refresh_token: 'token-ngawur' })).status).toBe(401);
      expect((await post('/auth/refresh', { refresh_token: '' })).status).toBe(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('204 dan access token dicabut; token yang sama tidak bisa dipakai lagi', async () => {
      const { session } = await readJson(await post('/auth/register', registerBody()));
      const headers = { authorization: `Bearer ${session.access_token}` };

      const res = await post('/auth/logout', {}, headers);
      expect(res.status).toBe(204);
      expect(provider.revokedAccessTokens).toEqual([session.access_token]);

      expect((await post('/auth/logout', {}, headers)).status).toBe(401);
    });

    it('401 tanpa token atau dengan token ngawur', async () => {
      expect((await post('/auth/logout', {})).status).toBe(401);
      expect((await post('/auth/logout', {}, { authorization: 'Bearer ngawur' })).status).toBe(401);
      expect(provider.revokedAccessTokens).toEqual([]);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('200 dengan pesan yang sama untuk email terdaftar maupun tidak', async () => {
      await post('/auth/register', registerBody());

      const known = await post('/auth/forgot-password', { email: 'dey@example.com' });
      const unknown = await post('/auth/forgot-password', { email: 'hantu@example.com' });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await readJson(known)).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      expect(await readJson(unknown)).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    });

    it('400 untuk email tidak sah', async () => {
      expect((await post('/auth/forgot-password', { email: 'bukan-email' })).status).toBe(400);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('204 dengan token pemulihan valid; login memakai password baru', async () => {
      await post('/auth/register', registerBody());
      provider.recoveryTokens.set('token-pemulihan', 'dey@example.com');

      const res = await post('/auth/reset-password', { token: 'token-pemulihan', password: 'password-baru-456' });
      expect(res.status).toBe(204);

      expect((await post('/auth/login', { email: 'dey@example.com', password: 'rahasia-banget-123' })).status).toBe(401);
      expect((await post('/auth/login', { email: 'dey@example.com', password: 'password-baru-456' })).status).toBe(200);
    });

    it('401 untuk token tidak valid, 400 untuk password terlalu pendek', async () => {
      expect((await post('/auth/reset-password', { token: 'ngawur', password: 'password-baru-456' })).status).toBe(401);
      expect((await post('/auth/reset-password', { token: 'ngawur', password: 'pendek' })).status).toBe(400);
    });
  });
});
