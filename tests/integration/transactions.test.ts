// Integration test modul transactions. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider. Dilewati bila
// Postgres test tidak menyala.
//
// Dua pengguna: A (penguji) dan B (korban). Data B diberi nama khas supaya kebocoran sekecil
// apa pun terlihat di respons. Kontrak: claude/API.md bagian 6.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import {
  transactionDetailSchema,
  transactionListSchema,
  transactionSchema,
} from '../../src/modules/transactions/transactions.schema.js';
import { createTransactionsSummary } from '../../src/modules/transactions/transactions.summary.js';
import { addDays, jakartaDayStartUtc, oneYearBefore, todayInJakarta } from '../../src/shared/utils/timezone.js';
import { postJson, readJson, startServer, type JsonBody, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface TestUser {
  id: string;
  email: string;
  token: string;
}

interface Refs {
  expense: string;
  income: string;
  account: string;
}

interface SeedOptions {
  date: string;
  amount?: number;
  type?: 'income' | 'expense';
  description?: string | null;
  source?: string;
  deleted?: boolean;
  accountId?: string;
  sourceMessageId?: string;
}

describe.skipIf(!testDbUrl)('modul transactions (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let server: TestServer;
  let a: TestUser;
  let b: TestUser;
  let refsA: Refs;
  let refsB: Refs;
  const today = todayInJakarta();

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
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

  async function refsOf(user: TestUser): Promise<Refs> {
    const [expense, income, account] = await Promise.all([
      prisma.category.findFirstOrThrow({ where: { userId: user.id, type: 'expense' }, orderBy: { sortOrder: 'asc' } }),
      prisma.category.findFirstOrThrow({ where: { userId: user.id, type: 'income' }, orderBy: { sortOrder: 'asc' } }),
      prisma.account.findFirstOrThrow({ where: { userId: user.id } }),
    ]);
    return { expense: expense.id, income: income.id, account: account.id };
  }

  beforeEach(async () => {
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
    refsA = await refsOf(a);
    refsB = await refsOf(b);
  });

  afterEach(async () => {
    await server.close();
  });

  // ---- alat bantu ----

  const call = (method: string, path: string, user?: TestUser, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(user && { authorization: `Bearer ${user.token}` }),
        ...headers,
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  const validBody = (refs: Refs = refsA, overrides: JsonBody = {}): JsonBody => ({
    type: 'expense',
    amount: 25000,
    category_id: refs.expense,
    account_id: refs.account,
    date: today,
    description: 'makan siang',
    ...overrides,
  });

  async function createVia(user: TestUser, body: JsonBody): Promise<JsonBody> {
    const res = await call('POST', '/transactions', user, body);
    expect(res.status).toBe(201);
    return readJson(res);
  }

  async function seed(user: TestUser, refs: Refs, options: SeedOptions) {
    const type = options.type ?? 'expense';
    return prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: options.accountId ?? refs.account,
        categoryId: type === 'income' ? refs.income : refs.expense,
        type,
        amount: options.amount ?? 10000,
        occurredAt: jakartaDayStartUtc(options.date),
        description: options.description ?? null,
        source: options.source ?? 'manual',
        ...(options.deleted && { deletedAt: new Date() }),
        ...(options.sourceMessageId && { sourceMessageId: options.sourceMessageId }),
      },
    });
  }

  /** Seluruh teks respons: kebocoran di field mana pun ikut tertangkap. */
  const textOf = async (res: Response) => JSON.stringify(await readJson(res));

  const listIds = async (path: string, user: TestUser = a): Promise<string[]> => {
    const res = await call('GET', path, user);
    expect(res.status).toBe(200);
    return ((await readJson(res)).data as JsonBody[]).map((row) => row.id);
  };

  // ---- autentikasi ----

  describe('autentikasi', () => {
    it.each([
      ['GET /transactions', 'GET', '/transactions', undefined],
      ['POST /transactions', 'POST', '/transactions', {}],
      ['GET /transactions/:id', 'GET', `/transactions/${UNKNOWN_ID}`, undefined],
      ['PATCH /transactions/:id', 'PATCH', `/transactions/${UNKNOWN_ID}`, {}],
      ['DELETE /transactions/:id', 'DELETE', `/transactions/${UNKNOWN_ID}`, undefined],
      ['POST /transactions/:id/restore', 'POST', `/transactions/${UNKNOWN_ID}/restore`, undefined],
    ])('%s: 401 tanpa token dan dengan token ngawur', async (_name, method, path, body) => {
      const missing = await call(method, path, undefined, body);
      expect(missing.status).toBe(401);
      expect((await readJson(missing)).error.code).toBe('UNAUTHORIZED');
      expect((await call(method, path, { ...a, token: 'ngawur' }, body)).status).toBe(401);
    });
  });

  // ---- CRUD ----

  describe('POST /transactions', () => {
    it('201: sesuai kontrak, tersimpan sebagai milik pemanggil dan source manual', async () => {
      const res = await call('POST', '/transactions', a, validBody());
      expect(res.status).toBe(201);
      const body = await readJson(res);

      transactionSchema.parse(body);
      expect(Object.keys(body).sort()).toEqual(
        ['account', 'amount', 'category', 'created_at', 'date', 'description', 'id', 'source', 'type', 'updated_at'],
      );
      expect(body).toMatchObject({
        type: 'expense',
        amount: 25000,
        date: today,
        description: 'makan siang',
        source: 'manual',
        category: { id: refsA.expense },
        account: { id: refsA.account, name: 'Tunai' },
      });

      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: body.id } });
      expect(row).toMatchObject({ userId: a.id, source: 'manual', amount: 25000, deletedAt: null });
    });

    it('occurred_at awal hari Jakarta dan kolom date (generated) sama dengan tanggal yang dikirim', async () => {
      const date = addDays(today, -3);
      const { id } = await createVia(a, validBody(refsA, { date }));
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id } });
      expect(row.occurredAt).toEqual(jakartaDayStartUtc(date));
      expect(row.date.toISOString().slice(0, 10)).toBe(date);
    });

    it('deskripsi opsional: tanpa deskripsi menjadi null, dipangkas spasinya', async () => {
      const withoutDescription = validBody();
      delete withoutDescription.description;
      expect((await createVia(a, withoutDescription)).description).toBeNull();
      expect((await createVia(a, validBody(refsA, { description: '  kopi  ' }))).description).toBe('kopi');
    });

    it('pemasukan dengan kategori pemasukan', async () => {
      const body = await createVia(a, validBody(refsA, { type: 'income', category_id: refsA.income, amount: 5_000_000 }));
      expect(body).toMatchObject({ type: 'income', amount: 5_000_000 });
    });

    it('kategori sistem (user_id NULL) boleh dipakai', async () => {
      const system = await prisma.category.findFirstOrThrow({ where: { userId: null, type: 'expense' } });
      const body = await createVia(a, validBody(refsA, { category_id: system.id }));
      expect(body.category.id).toBe(system.id);
    });

    it('batas: Rp1 miliar, hari ini, dan tepat satu tahun ke belakang diterima', async () => {
      await createVia(a, validBody(refsA, { amount: 1_000_000_000 }));
      await createVia(a, validBody(refsA, { date: oneYearBefore(today) }));
    });

    it.each([
      ['nominal nol', { amount: 0 }],
      ['nominal negatif', { amount: -25000 }],
      ['nominal desimal', { amount: 25000.5 }],
      ['nominal string', { amount: '25 ribu' }],
      ['nominal di atas Rp1 miliar', { amount: 1_000_000_001 }],
      ['tipe tak dikenal', { type: 'transfer' }],
      ['tanggal di masa depan', { date: addDays(today, 1) }],
      ['tanggal lebih dari setahun ke belakang', { date: addDays(oneYearBefore(today), -1) }],
      ['tanggal bukan tanggal', { date: 'kemarin' }],
      ['tanggal tidak ada di kalender', { date: '2026-02-30' }],
      ['deskripsi lebih dari 255 karakter', { description: 'x'.repeat(256) }],
      ['category_id bukan UUID', { category_id: 'makanan' }],
    ])('400 untuk %s, dan tidak ada yang tersimpan', async (_name, overrides) => {
      const res = await call('POST', '/transactions', a, validBody(refsA, overrides));
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.transaction.count()).toBe(0);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('400 bila field wajib hilang', async () => {
      const res = await call('POST', '/transactions', a, {});
      expect(res.status).toBe(400);
      const fields = ((await readJson(res)).error.details as JsonBody[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['type', 'amount', 'category_id', 'account_id', 'date']));
    });

    it('400 type_mismatch: pengeluaran ke kategori pemasukan, dan sebaliknya', async () => {
      for (const overrides of [{ category_id: refsA.income }, { type: 'income' }]) {
        const res = await call('POST', '/transactions', a, validBody(refsA, overrides));
        expect(res.status).toBe(400);
        const { error } = await readJson(res);
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.details).toEqual([{ field: 'category_id', issue: 'type_mismatch' }]);
      }
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('404 bila kategori atau akun tidak ada', async () => {
      const noCategory = await call('POST', '/transactions', a, validBody(refsA, { category_id: UNKNOWN_ID }));
      expect(noCategory.status).toBe(404);
      const noAccount = await call('POST', '/transactions', a, validBody(refsA, { account_id: UNKNOWN_ID }));
      expect(noAccount.status).toBe(404);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('404 bila kategori sudah di-soft-delete', async () => {
      await prisma.category.update({ where: { id: refsA.expense }, data: { deletedAt: new Date() } });
      expect((await call('POST', '/transactions', a, validBody())).status).toBe(404);
    });

    it('429 setelah 60 permintaan per menit per pengguna; pengguna lain tidak terdampak', async () => {
      for (let i = 0; i < 60; i += 1) {
        expect((await call('POST', '/transactions', a, {})).status).toBe(400);
      }
      const limited = await call('POST', '/transactions', a, {});
      expect(limited.status).toBe(429);
      expect((await readJson(limited)).error.code).toBe('RATE_LIMITED');
      expect((await call('POST', '/transactions', b, {})).status).toBe(400);
    });
  });

  describe('GET /transactions/:id', () => {
    it('200: TransactionDetail dengan source_message null untuk transaksi manual', async () => {
      const { id } = await createVia(a, validBody());
      const res = await call('GET', `/transactions/${id}`, a);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      transactionDetailSchema.parse(body);
      expect(body).toMatchObject({ id, amount: 25000, source: 'manual', source_message: null });
    });

    it('source_message berisi isi pesan asli dan waktu terima untuk transaksi WhatsApp', async () => {
      const message = await prisma.messageLog.create({
        data: {
          userId: a.id,
          sessionId: 'sesi-test',
          waMessageId: 'wamid-1',
          waChatId: '628111111111@c.us',
          direction: 'inbound',
          body: 'tadi makan siang 25 ribu',
          messageType: 'chat',
          status: 'processed',
        },
      });
      const row = await seed(a, refsA, { date: today, amount: 25000, source: 'whatsapp', sourceMessageId: message.id });

      const body = await readJson(await call('GET', `/transactions/${row.id}`, a));
      expect(body.source).toBe('whatsapp');
      expect(body.source_message).toEqual({
        body: 'tadi makan siang 25 ribu',
        received_at: message.createdAt.toISOString(),
      });
    });

    it('transaksi WhatsApp yang pesannya sudah tidak ada: source_message null, bukan error', async () => {
      const row = await seed(a, refsA, { date: today, source: 'whatsapp' });
      const res = await call('GET', `/transactions/${row.id}`, a);
      expect(res.status).toBe(200);
      expect((await readJson(res)).source_message).toBeNull();
    });

    it('404 untuk id yang tidak ada; 400 untuk id bukan UUID', async () => {
      expect((await call('GET', `/transactions/${UNKNOWN_ID}`, a)).status).toBe(404);
      const bad = await call('GET', '/transactions/bukan-uuid', a);
      expect(bad.status).toBe(400);
      expect((await readJson(bad)).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /transactions/:id', () => {
    it('200: mengubah sebagian field, sisanya tetap; updated_at maju', async () => {
      const created = await createVia(a, validBody());
      const res = await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        amount: 30000,
        description: 'makan siang + es teh',
      });
      expect(res.status).toBe(200);
      const body = transactionSchema.parse(await readJson(res));
      expect(body).toMatchObject({
        id: created.id,
        amount: 30000,
        description: 'makan siang + es teh',
        type: 'expense',
        date: today,
        category: { id: refsA.expense },
      });
      expect(Date.parse(body.updated_at)).toBeGreaterThan(Date.parse(created.updated_at));
      expect(body.created_at).toBe(created.created_at);
    });

    it('description null mengosongkan deskripsi', async () => {
      const created = await createVia(a, validBody());
      const body = await readJson(
        await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, description: null }),
      );
      expect(body.description).toBeNull();
    });

    it('mengubah tanggal memindahkan transaksi; tanggal yang sama tidak menyentuh occurred_at', async () => {
      const created = await createVia(a, validBody());
      // Jam asli (mis. dari WhatsApp) harus selamat dari PATCH yang mengirim tanggal yang sama.
      const withTime = new Date(jakartaDayStartUtc(today).getTime() + 13 * 3600_000);
      await prisma.transaction.update({ where: { id: created.id }, data: { occurredAt: withTime } });
      const current = await readJson(await call('GET', `/transactions/${created.id}`, a));

      const same = await readJson(
        await call('PATCH', `/transactions/${created.id}`, a, { updated_at: current.updated_at, date: today, amount: 1 }),
      );
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).occurredAt).toEqual(withTime);

      const moved = addDays(today, -7);
      const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: same.updated_at, date: moved });
      expect((await readJson(res)).date).toBe(moved);
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.occurredAt).toEqual(jakartaDayStartUtc(moved));
      expect(row.date.toISOString().slice(0, 10)).toBe(moved);
    });

    it('type dan category_id boleh berubah bersamaan ke pasangan yang cocok', async () => {
      const created = await createVia(a, validBody());
      const res = await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        type: 'income',
        category_id: refsA.income,
      });
      expect(res.status).toBe(200);
      expect(await readJson(res)).toMatchObject({ type: 'income', category: { id: refsA.income } });
    });

    it('400 type_mismatch bila hanya type berubah, atau hanya category_id berubah; data tetap', async () => {
      const created = await createVia(a, validBody());
      for (const change of [{ type: 'income' }, { category_id: refsA.income }]) {
        const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, ...change });
        expect(res.status).toBe(400);
        expect((await readJson(res)).error.details).toEqual([{ field: 'category_id', issue: 'type_mismatch' }]);
      }
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        type: 'expense',
        categoryId: refsA.expense,
      });
    });

    it('404 bila category_id atau account_id baru tidak ada', async () => {
      const created = await createVia(a, validBody());
      for (const change of [{ category_id: UNKNOWN_ID }, { account_id: UNKNOWN_ID }]) {
        const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, ...change });
        expect(res.status).toBe(404);
      }
    });

    it('source, user_id, dan id di body tidak bisa diubah (dibuang validasi)', async () => {
      const created = await createVia(a, validBody());
      const res = await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        amount: 1,
        source: 'whatsapp',
        user_id: b.id,
        id: UNKNOWN_ID,
      });
      expect(res.status).toBe(200);
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        source: 'manual',
        userId: a.id,
        amount: 1,
      });
    });

    it.each<[string, (updatedAt: string) => JsonBody]>([
      ['updated_at tidak dikirim', () => ({ amount: 30000 })],
      ['hanya updated_at', (updatedAt) => ({ updated_at: updatedAt })],
      ['updated_at bukan timestamp', () => ({ updated_at: 'kemarin', amount: 30000 })],
      ['nominal desimal', (updatedAt) => ({ updated_at: updatedAt, amount: 30000.5 })],
      ['nominal di atas Rp1 miliar', (updatedAt) => ({ updated_at: updatedAt, amount: 1_000_000_001 })],
      ['tanggal di masa depan', (updatedAt) => ({ updated_at: updatedAt, date: addDays(today, 1) })],
      [
        'tanggal lebih dari setahun ke belakang',
        (updatedAt) => ({ updated_at: updatedAt, date: addDays(oneYearBefore(today), -1) }),
      ],
    ])('400 untuk %s, dan data tidak berubah', async (_name, buildBody) => {
      const created = await createVia(a, validBody());
      const res = await call('PATCH', `/transactions/${created.id}`, a, buildBody(created.updated_at));
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        amount: 25000,
        description: 'makan siang',
      });
      expect(await prisma.auditLog.count({ where: { action: 'update' } })).toBe(0);
    });

    it('404 untuk id yang tidak ada', async () => {
      const res = await call('PATCH', `/transactions/${UNKNOWN_ID}`, a, { updated_at: '2026-09-28T05:12:35Z', amount: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe('optimistic locking', () => {
    it('409 CONFLICT untuk updated_at basi, dan data hasil PATCH pertama tidak tertimpa', async () => {
      const created = await createVia(a, validBody());
      const first = await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        amount: 30000,
      });
      expect(first.status).toBe(200);
      const latest = await readJson(first);

      const stale = await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        amount: 35000,
      });
      expect(stale.status).toBe(409);
      const { error } = await readJson(stale);
      expect(error.code).toBe('CONFLICT');
      expect(error.details).toEqual([{ field: 'updated_at', issue: 'stale' }]);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).amount).toBe(30000);

      // Memuat ulang lalu mencoba lagi dengan updated_at terbaru berhasil.
      const retry = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: latest.updated_at, amount: 35000 });
      expect(retry.status).toBe(200);
      expect((await readJson(retry)).amount).toBe(35000);
    });

    it('perubahan di luar API (mis. worker WhatsApp) juga membuat updated_at klien basi', async () => {
      const created = await createVia(a, validBody());
      await prisma.transaction.update({ where: { id: created.id }, data: { amount: 99000 } });
      const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount: 1 });
      expect(res.status).toBe(409);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).amount).toBe(99000);
    });

    it('PATCH berurutan secepat mungkin: updated_at selalu naik, jadi nilai lama selalu basi', async () => {
      const created = await createVia(a, validBody());
      const seen = [created.updated_at as string];
      for (let amount = 1; amount <= 6; amount += 1) {
        const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: seen.at(-1), amount });
        expect(res.status).toBe(200);
        seen.push((await readJson(res)).updated_at);
      }
      expect(new Set(seen).size).toBe(seen.length);
      for (let i = 1; i < seen.length; i += 1) {
        expect(Date.parse(seen[i] as string)).toBeGreaterThan(Date.parse(seen[i - 1] as string));
      }
      for (const old of seen.slice(0, -1)) {
        expect((await call('PATCH', `/transactions/${created.id}`, a, { updated_at: old, amount: 999 })).status).toBe(409);
      }
    });

    it('dua PATCH serentak dengan updated_at sama: tepat satu menang, satu 409', async () => {
      const created = await createVia(a, validBody());
      const results = await Promise.all(
        [111, 222].map(async (amount) => {
          const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount });
          return { status: res.status, amount };
        }),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).amount).toBe(winner?.amount);
    });

    it('PATCH yang tidak mengubah apa pun: 200, updated_at tetap, tanpa baris audit', async () => {
      const created = await createVia(a, validBody());
      const res = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount: 25000 });
      expect(res.status).toBe(200);
      expect((await readJson(res)).updated_at).toBe(created.updated_at);
      expect(await prisma.auditLog.count({ where: { action: 'update' } })).toBe(0);
    });
  });

  // ---- soft delete dan restore ----

  describe('DELETE dan restore', () => {
    it('soft delete: 204, hilang dari daftar dan detail, tetapi barisnya tetap ada dengan deleted_at', async () => {
      const { id } = await createVia(a, validBody());
      expect(await listIds('/transactions')).toEqual([id]);

      const res = await call('DELETE', `/transactions/${id}`, a);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');

      expect(await listIds('/transactions')).toEqual([]);
      expect((await call('GET', `/transactions/${id}`, a)).status).toBe(404);
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id } })).toMatchObject({
        deletedAt: expect.any(Date),
        amount: 25000,
      });
    });

    it('transaksi terhapus tidak bisa di-PATCH, dan DELETE kedua 404', async () => {
      const created = await createVia(a, validBody());
      await call('DELETE', `/transactions/${created.id}`, a);
      const patch = await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount: 1 });
      expect(patch.status).toBe(404);
      expect((await call('DELETE', `/transactions/${created.id}`, a)).status).toBe(404);
    });

    it('restore: 200 Transaction yang sama, muncul lagi di daftar dan detail, deleted_at kembali null', async () => {
      const created = await createVia(a, validBody());
      await call('DELETE', `/transactions/${created.id}`, a);

      const res = await call('POST', `/transactions/${created.id}/restore`, a);
      expect(res.status).toBe(200);
      const body = transactionSchema.parse(await readJson(res));
      expect(body).toMatchObject({ id: created.id, amount: 25000, description: 'makan siang' });

      expect(await listIds('/transactions')).toEqual([created.id]);
      expect((await call('GET', `/transactions/${created.id}`, a)).status).toBe(200);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.id } })).deletedAt).toBeNull();
    });

    it('restore membuat updated_at lama basi dan yang baru bisa dipakai untuk PATCH', async () => {
      const created = await createVia(a, validBody());
      await call('DELETE', `/transactions/${created.id}`, a);
      const restored = await readJson(await call('POST', `/transactions/${created.id}/restore`, a));
      expect(restored.updated_at).not.toBe(created.updated_at);
      expect((await call('PATCH', `/transactions/${created.id}`, a, { updated_at: restored.updated_at, amount: 1 })).status).toBe(200);
    });

    it('restore 404 bila transaksi belum dihapus atau tidak ada', async () => {
      const { id } = await createVia(a, validBody());
      expect((await call('POST', `/transactions/${id}/restore`, a)).status).toBe(404);
      expect((await call('POST', `/transactions/${UNKNOWN_ID}/restore`, a)).status).toBe(404);
    });

    it('400 untuk id bukan UUID', async () => {
      expect((await call('DELETE', '/transactions/bukan-uuid', a)).status).toBe(400);
      expect((await call('POST', '/transactions/bukan-uuid/restore', a)).status).toBe(400);
    });
  });

  // ---- daftar: paginasi dan filter ----

  describe('GET /transactions: paginasi cursor', () => {
    it('200: {data, next_cursor, has_more} sesuai kontrak; daftar kosong untuk pengguna baru', async () => {
      const empty = await readJson(await call('GET', '/transactions', a));
      expect(transactionListSchema.parse(empty)).toEqual({ data: [], next_cursor: null, has_more: false });

      await seed(a, refsA, { date: today });
      const filled = transactionListSchema.parse(await readJson(await call('GET', '/transactions', a)));
      expect(filled.data).toHaveLength(1);
      expect(filled.has_more).toBe(false);
    });

    it('terurut menurut tanggal menurun; satu tanggal diurutkan menurut id', async () => {
      const rows = [
        await seed(a, refsA, { date: addDays(today, -2) }),
        await seed(a, refsA, { date: today }),
        await seed(a, refsA, { date: addDays(today, -2) }),
        await seed(a, refsA, { date: addDays(today, -1) }),
      ];
      const expected = rows
        .map((r) => ({ id: r.id, date: r.date.toISOString().slice(0, 10) }))
        .sort((x, y) => y.date.localeCompare(x.date) || (y.id < x.id ? -1 : 1))
        .map((r) => r.id);
      expect(await listIds('/transactions')).toEqual(expected);
    });

    it('menggulir semua halaman tanpa baris ganda atau terlewat, termasuk tanggal kembar', async () => {
      const rows = [];
      for (let i = 1; i <= 5; i += 1) rows.push(await seed(a, refsA, { date: addDays(today, -i) }));
      for (let i = 0; i < 3; i += 1) rows.push(await seed(a, refsA, { date: addDays(today, -10) }));
      const expected = rows
        .map((r) => ({ id: r.id, date: r.date.toISOString().slice(0, 10) }))
        .sort((x, y) => y.date.localeCompare(x.date) || (y.id < x.id ? -1 : 1))
        .map((r) => r.id);

      const collected: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const res: Response = await call('GET', `/transactions?limit=3${cursor ? `&cursor=${cursor}` : ''}`, a);
        expect(res.status).toBe(200);
        const page = await readJson(res);
        sizes.push(page.data.length);
        collected.push(...page.data.map((row: JsonBody) => row.id));
        expect(page.has_more).toBe(page.next_cursor !== null);
        cursor = page.next_cursor;
      } while (cursor);

      expect(sizes).toEqual([3, 3, 2]);
      expect(collected).toEqual(expected);
    });

    it('transaksi baru di bagian atas saat menggulir tidak menggeser halaman berikutnya (alasan memakai cursor)', async () => {
      const rows = [];
      for (let i = 1; i <= 5; i += 1) rows.push(await seed(a, refsA, { date: addDays(today, -i) }));
      const first = await readJson(await call('GET', '/transactions?limit=2', a));

      const added = await seed(a, refsA, { date: today });
      const second = await readJson(await call('GET', `/transactions?limit=2&cursor=${first.next_cursor}`, a));
      const third = await readJson(await call('GET', `/transactions?limit=2&cursor=${second.next_cursor}`, a));

      const seen = [...first.data, ...second.data, ...third.data].map((row: JsonBody) => row.id);
      expect(seen).toEqual(rows.map((r) => r.id)); // lima baris awal, urut, tanpa ganda atau lompat
      expect(seen).not.toContain(added.id);
      expect(third.has_more).toBe(false);
    });

    it('baris yang dihapus di tengah menggulir tidak merusak cursor', async () => {
      const rows = [];
      for (let i = 1; i <= 4; i += 1) rows.push(await seed(a, refsA, { date: addDays(today, -i) }));
      const first = await readJson(await call('GET', '/transactions?limit=2', a));
      // Baris yang menjadi patokan cursor dihapus: halaman berikutnya tetap lanjut dari posisinya.
      await call('DELETE', `/transactions/${first.data[1].id}`, a);
      const second = await readJson(await call('GET', `/transactions?limit=2&cursor=${first.next_cursor}`, a));
      expect(second.data.map((row: JsonBody) => row.id)).toEqual([rows[2]?.id, rows[3]?.id]);
    });

    it('limit default 20 dan maksimum 100', async () => {
      for (let i = 0; i < 21; i += 1) await seed(a, refsA, { date: addDays(today, -i) });
      const page = await readJson(await call('GET', '/transactions', a));
      expect(page.data).toHaveLength(20);
      expect(page.has_more).toBe(true);
      expect((await call('GET', '/transactions?limit=100', a)).status).toBe(200);
    });

    it.each([
      ['limit 0', '?limit=0'],
      ['limit 101', '?limit=101'],
      ['limit bukan angka', '?limit=banyak'],
      ['cursor ngawur', '?cursor=ngawur'],
      ['cursor JSON tanpa bentuk yang benar', `?cursor=${Buffer.from('{"x":1}').toString('base64url')}`],
      ['from setelah to', '?from=2026-09-30&to=2026-09-01'],
      ['tanggal tidak sah', '?from=kemarin'],
      ['type tak dikenal', '?type=transfer'],
      ['source tak dikenal', '?source=telegram'],
      ['category_id bukan UUID', '?category_id=makanan'],
      ['q kosong', '?q='],
    ])('400 untuk %s', async (_name, query) => {
      const res = await call('GET', `/transactions${query}`, a);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /transactions: filter', () => {
    let bank: string;
    let d1: string;
    let d2: string;
    let d3: string;
    let d4: string;
    let d5: string;

    beforeEach(async () => {
      bank = (await prisma.account.create({ data: { userId: a.id, name: 'Bank', type: 'bank' } })).id;
      d1 = (await seed(a, refsA, { date: addDays(today, -10), description: 'Makan siang di warung' })).id;
      d2 = (await seed(a, refsA, { date: addDays(today, -5), amount: 20000, description: 'bensin', source: 'whatsapp' })).id;
      d3 = (await seed(a, refsA, { date: addDays(today, -5), type: 'income', amount: 5_000_000, description: 'gaji' })).id;
      d4 = (await seed(a, refsA, { date: today, amount: 30000, accountId: bank })).id;
      d5 = (await seed(a, refsA, { date: today, description: 'terhapus', deleted: true })).id;
    });

    it('tanpa filter: semua yang aktif, yang terhapus tidak ikut', async () => {
      const ids = await listIds('/transactions');
      expect(ids).toHaveLength(4);
      expect(ids).not.toContain(d5);
    });

    it('from dan to inklusif, bisa dipakai sendiri-sendiri', async () => {
      const both = await listIds(`/transactions?from=${addDays(today, -5)}&to=${addDays(today, -5)}`);
      expect(both.sort()).toEqual([d2, d3].sort());
      expect(await listIds(`/transactions?from=${addDays(today, -5)}`)).toHaveLength(3);
      expect(await listIds(`/transactions?to=${addDays(today, -6)}`)).toEqual([d1]);
    });

    it('type', async () => {
      expect(await listIds('/transactions?type=income')).toEqual([d3]);
      expect(await listIds('/transactions?type=expense')).toHaveLength(3);
    });

    it('category_id dan account_id', async () => {
      expect(await listIds(`/transactions?category_id=${refsA.income}`)).toEqual([d3]);
      expect(await listIds(`/transactions?account_id=${bank}`)).toEqual([d4]);
      expect(await listIds(`/transactions?account_id=${UNKNOWN_ID}`)).toEqual([]);
    });

    it('source', async () => {
      expect(await listIds('/transactions?source=whatsapp')).toEqual([d2]);
      expect(await listIds('/transactions?source=import')).toEqual([]);
    });

    it('q mencari deskripsi tanpa membedakan huruf besar kecil', async () => {
      expect(await listIds('/transactions?q=MAKAN')).toEqual([d1]);
      expect(await listIds('/transactions?q=warung')).toEqual([d1]);
      expect(await listIds('/transactions?q=tidak-ada')).toEqual([]);
      expect(await listIds('/transactions?q=terhapus')).toEqual([]);
    });

    it('filter digabung (AND), termasuk dengan cursor', async () => {
      expect(await listIds(`/transactions?type=expense&from=${addDays(today, -5)}&source=whatsapp`)).toEqual([d2]);

      const first = await readJson(await call('GET', '/transactions?type=expense&limit=1', a));
      expect(first.data).toHaveLength(1);
      const next = await readJson(await call('GET', `/transactions?type=expense&limit=5&cursor=${first.next_cursor}`, a));
      const all = [...first.data, ...next.data].map((row: JsonBody) => row.id);
      expect(all.sort()).toEqual([d1, d2, d4].sort());
      expect(all).not.toContain(d3);
    });

    it('q dengan karakter khusus SQL diperlakukan sebagai teks biasa', async () => {
      expect(await listIds(`/transactions?q=${encodeURIComponent("'; DROP TABLE transactions; --")}`)).toEqual([]);
      expect(await prisma.transaction.count()).toBe(5);
    });
  });

  // ---- isolasi antar-pengguna ----

  describe('isolasi antar-pengguna', () => {
    let secret: JsonBody;

    beforeEach(async () => {
      secret = await createVia(b, validBody(refsB, { description: 'Rahasia-B', amount: 7_777_777 }));
      await createVia(a, validBody(refsA, { description: 'milik-A' }));
    });

    it('daftar A tidak memuat transaksi B, dan sebaliknya', async () => {
      const forA = await textOf(await call('GET', '/transactions', a));
      expect(forA).not.toContain('Rahasia-B');
      expect(forA).toContain('milik-A');
      const forB = await textOf(await call('GET', '/transactions', b));
      expect(forB).toContain('Rahasia-B');
      expect(forB).not.toContain('milik-A');
    });

    it('filter, pencarian, dan cursor tidak melintasi batas pemilik', async () => {
      expect(await listIds('/transactions?q=Rahasia')).toEqual([]);
      expect(await listIds(`/transactions?category_id=${refsB.expense}`)).toEqual([]);
      expect(await listIds(`/transactions?account_id=${refsB.account}`)).toEqual([]);
      // Cursor yang menunjuk baris B tidak membuka apa pun milik B.
      const cursor = Buffer.from(JSON.stringify({ d: addDays(today, 1), i: secret.id })).toString('base64url');
      const res = await call('GET', `/transactions?cursor=${cursor}`, a);
      expect(await textOf(res)).not.toContain('Rahasia-B');
    });

    it('GET, PATCH, DELETE, dan restore atas id milik B dengan token A: 404, dan B utuh', async () => {
      expect((await call('GET', `/transactions/${secret.id}`, a)).status).toBe(404);
      const patch = await call('PATCH', `/transactions/${secret.id}`, a, { updated_at: secret.updated_at, amount: 1 });
      expect(patch.status).toBe(404);
      expect((await call('DELETE', `/transactions/${secret.id}`, a)).status).toBe(404);
      expect((await call('POST', `/transactions/${secret.id}/restore`, a)).status).toBe(404);

      // Restore pada baris B yang sudah terhapus pun tidak boleh bekerja untuk A.
      await call('DELETE', `/transactions/${secret.id}`, b);
      expect((await call('POST', `/transactions/${secret.id}/restore`, a)).status).toBe(404);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: secret.id } })).deletedAt).not.toBeNull();
      await call('POST', `/transactions/${secret.id}/restore`, b);

      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: secret.id } })).toMatchObject({
        userId: b.id,
        amount: 7_777_777,
        description: 'Rahasia-B',
        deletedAt: null,
      });
      // Tidak ada audit untuk percobaan A pada baris B.
      expect(await prisma.auditLog.count({ where: { entityId: secret.id, userId: a.id } })).toBe(0);
    });

    it('404 (bukan 403) untuk id milik B: keberadaannya tidak terungkap', async () => {
      const own404 = await readJson(await call('GET', `/transactions/${UNKNOWN_ID}`, a));
      const foreign404 = await readJson(await call('GET', `/transactions/${secret.id}`, a));
      expect(foreign404).toEqual(own404);
    });

    it('A tidak bisa memakai kategori kustom, kategori terhapus, atau akun milik B', async () => {
      const custom = await prisma.category.create({
        data: { userId: b.id, name: 'Kategori-Rahasia-B', slug: 'rahasia-b', type: 'expense', icon: 'lock', color: '#000001', keywords: [] },
      });
      for (const overrides of [{ category_id: custom.id }, { category_id: refsB.expense }, { account_id: refsB.account }]) {
        const res = await call('POST', '/transactions', a, validBody(refsA, overrides));
        expect(res.status).toBe(404);
        expect(await textOf(res)).not.toContain('Rahasia');
      }
      // Dan lewat PATCH pada transaksi milik A sendiri.
      const own = await createVia(a, validBody());
      for (const change of [{ category_id: refsB.expense }, { account_id: refsB.account }]) {
        const res = await call('PATCH', `/transactions/${own.id}`, a, { updated_at: own.updated_at, ...change });
        expect(res.status).toBe(404);
      }
      expect(await prisma.transaction.count({ where: { userId: a.id } })).toBe(2);
    });

    it('user_id di body, query, dan header diabaikan: transaksi tetap milik A', async () => {
      const res = await call(
        'POST',
        `/transactions?user_id=${b.id}`,
        a,
        validBody(refsA, { user_id: b.id, userId: b.id, description: 'coba-bajak' }),
        { 'x-user-id': b.id },
      );
      expect(res.status).toBe(201);
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: (await readJson(res)).id } });
      expect(row.userId).toBe(a.id);
      expect(await textOf(await call('GET', `/transactions?user_id=${b.id}`, a, undefined, { 'x-user-id': b.id }))).not.toContain(
        'Rahasia-B',
      );
    });

    it('audit log mencatat pelaku yang benar untuk tiap pengguna', async () => {
      const rows = await prisma.auditLog.findMany({ where: { entityType: 'transaction' } });
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.entityId === secret.id)?.userId).toBe(b.id);
    });
  });

  // ---- audit ----

  describe('audit_logs', () => {
    const auditOf = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: { id: 'asc' } });

    it('create: satu baris dengan nilai sesudah, pelaku user, dan alamat IP', async () => {
      const created = await createVia(a, validBody());
      const rows = await auditOf(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: a.id,
        entityType: 'transaction',
        entityId: created.id,
        action: 'create',
        actorType: 'user',
        changes: {
          after: { type: 'expense', amount: 25000, date: today, description: 'makan siang', category_id: refsA.expense, account_id: refsA.account },
        },
      });
      expect(rows[0]?.ipAddress).toBeTruthy();
    });

    it('update: hanya field yang berubah, dengan nilai sebelum dan sesudah', async () => {
      const created = await createVia(a, validBody());
      await call('PATCH', `/transactions/${created.id}`, a, {
        updated_at: created.updated_at,
        amount: 30000,
        description: 'makan siang + es teh',
      });
      const rows = await auditOf(created.id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
      expect(rows[1]?.changes).toEqual({
        before: { amount: 25000, description: 'makan siang' },
        after: { amount: 30000, description: 'makan siang + es teh' },
      });
    });

    it('delete dan restore: masing-masing satu baris', async () => {
      const created = await createVia(a, validBody());
      await call('DELETE', `/transactions/${created.id}`, a);
      await call('POST', `/transactions/${created.id}/restore`, a);
      const rows = await auditOf(created.id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'delete', 'restore']);
      expect(rows[1]?.changes).toMatchObject({ before: { deleted_at: null }, after: { deleted_at: expect.any(String) } });
      expect(rows[2]?.changes).toMatchObject({ before: { deleted_at: expect.any(String) }, after: { deleted_at: null } });
      expect(rows.every((r) => r.userId === a.id && r.actorType === 'user')).toBe(true);
    });

    it('permintaan yang ditolak (400, 404, 409) tidak meninggalkan baris audit', async () => {
      const created = await createVia(a, validBody());
      await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount: 2 });
      const before = await prisma.auditLog.count();

      await call('POST', '/transactions', a, validBody(refsA, { amount: 0 }));
      await call('POST', '/transactions', a, validBody(refsA, { category_id: UNKNOWN_ID }));
      await call('PATCH', `/transactions/${created.id}`, a, { updated_at: created.updated_at, amount: 3 });
      await call('DELETE', `/transactions/${UNKNOWN_ID}`, a);
      await call('POST', `/transactions/${created.id}/restore`, a);

      expect(await prisma.auditLog.count()).toBe(before);
    });
  });

  // ---- transactions.summary.ts ----

  describe('transactions.summary', () => {
    it('sumByType: total per tipe, rentang inklusif, tanpa data terhapus atau milik pengguna lain', async () => {
      const summary = createTransactionsSummary(prisma);
      await seed(a, refsA, { date: addDays(today, -40), amount: 100 });
      await seed(a, refsA, { date: addDays(today, -2), amount: 20000 });
      await seed(a, refsA, { date: addDays(today, -2), amount: 5000 });
      await seed(a, refsA, { date: addDays(today, -1), type: 'income', amount: 3_000_000 });
      await seed(a, refsA, { date: today, amount: 7777, deleted: true });
      await seed(b, refsB, { date: today, amount: 999_999 });

      expect(await summary.sumByType(a.id)).toEqual({ income: 3_000_000, expense: 25100 });
      expect(await summary.sumByType(a.id, { from: addDays(today, -2), to: today })).toEqual({
        income: 3_000_000,
        expense: 25000,
      });
      expect(await summary.sumByType(a.id, { from: addDays(today, -2), to: addDays(today, -2) })).toEqual({
        income: 0,
        expense: 25000,
      });
      expect(await summary.sumByType(b.id)).toEqual({ income: 0, expense: 999_999 });
    });

    it('sumByType: tanpa transaksi menghasilkan nol, bukan null', async () => {
      expect(await createTransactionsSummary(prisma).sumByType(a.id)).toEqual({ income: 0, expense: 0 });
    });

    it('sumByType: nominal besar tidak meluap (jumlah melebihi Int32)', async () => {
      for (let i = 0; i < 3; i += 1) await seed(a, refsA, { date: today, amount: 1_000_000_000 });
      expect(await createTransactionsSummary(prisma).sumByType(a.id)).toEqual({ income: 0, expense: 3_000_000_000 });
    });

    it('dailyCashflow: satu entri per hari yang punya transaksi, naik menurut tanggal', async () => {
      const summary = createTransactionsSummary(prisma);
      await seed(a, refsA, { date: addDays(today, -1), amount: 10000 });
      await seed(a, refsA, { date: addDays(today, -3), amount: 4000 });
      await seed(a, refsA, { date: addDays(today, -3), amount: 6000 });
      await seed(a, refsA, { date: addDays(today, -3), type: 'income', amount: 50000 });
      await seed(a, refsA, { date: addDays(today, -2), amount: 1, deleted: true });
      await seed(b, refsB, { date: addDays(today, -1), amount: 123 });

      expect(await summary.dailyCashflow(a.id, { from: addDays(today, -5), to: today })).toEqual([
        { date: addDays(today, -3), income: 50000, expense: 10000 },
        { date: addDays(today, -1), income: 0, expense: 10000 },
      ]);
      expect(await summary.dailyCashflow(a.id, { from: addDays(today, -2), to: today })).toEqual([
        { date: addDays(today, -1), income: 0, expense: 10000 },
      ]);
    });

    it('batas hari Jakarta: transaksi 00:30 WIB tercatat di tanggal Jakarta, bukan tanggal UTC', async () => {
      // 00:30 WIB tanggal D = 17:30 UTC tanggal D-1. Kolom date harus tetap D.
      const date = addDays(today, -1);
      const occurredAt = new Date(jakartaDayStartUtc(date).getTime() + 30 * 60_000);
      await prisma.transaction.create({
        data: { userId: a.id, accountId: refsA.account, categoryId: refsA.expense, type: 'expense', amount: 5000, occurredAt, source: 'manual' },
      });
      expect(await createTransactionsSummary(prisma).dailyCashflow(a.id, { from: date, to: date })).toEqual([
        { date, income: 0, expense: 5000 },
      ]);
    });
  });
});
