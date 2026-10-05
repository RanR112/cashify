// Integration test seed pengguna demo. Prisma nyata ke Postgres test (docker compose up -d
// postgres-test); Supabase diganti FakeAuthProvider. Dilewati bila Postgres test tidak menyala.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildDemoDataset, DEMO_EMAIL, DEMO_PASSWORD } from '../../prisma/seed-demo-data.js';
import { seedDemo } from '../../prisma/seed-demo.js';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { createTransactionsSummary } from '../../src/modules/transactions/transactions.summary.js';
import { todayInJakarta } from '../../src/shared/utils/timezone.js';
import { readJson, startServer, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

// Tetap, supaya jumlah yang diharapkan tidak bergantung pada kapan test dijalankan.
const NOW = new Date('2026-10-03T05:00:00Z');
const dataset = buildDemoDataset(todayInJakarta(NOW));
const options = { email: DEMO_EMAIL, password: DEMO_PASSWORD, now: NOW };

describe.skipIf(!testDbUrl)('seed pengguna demo (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetUserData(prisma);
    await prisma.auditLog.deleteMany();
    await prisma.messageLog.deleteMany();
    await ensureSystemCategories(prisma);
    provider = new FakeAuthProvider(prisma);
  });

  const counts = async (userId: string) => ({
    transactions: await prisma.transaction.count({ where: { userId } }),
    deleted: await prisma.transaction.count({ where: { userId, deletedAt: { not: null } } }),
    messages: await prisma.messageLog.count({ where: { userId } }),
    audits: await prisma.auditLog.count({ where: { userId } }),
    accounts: await prisma.account.count({ where: { userId, deletedAt: null } }),
  });

  const expectedDeleted = dataset.transactions.filter((t) => t.deletedAt).length;
  const expectedMessages = dataset.transactions.filter((t) => t.source === 'whatsapp').length;

  it('membuat pengguna, dua dompet, dan seluruh transaksi beserta pesan dan audit', async () => {
    const result = await seedDemo(prisma, provider, { ...options, reset: false });

    expect(result.seededTransactions).toBe(true);
    expect(result.transactions).toBe(dataset.transactions.length);
    expect(await counts(result.userId)).toEqual({
      transactions: dataset.transactions.length,
      deleted: expectedDeleted,
      messages: expectedMessages,
      audits: dataset.transactions.length + expectedDeleted,
      accounts: 2,
    });

    const accounts = await prisma.account.findMany({ where: { userId: result.userId }, orderBy: { name: 'asc' } });
    expect(accounts.map((a) => [a.name, a.type, a.isDefault])).toEqual([
      ['BCA', 'bank', false],
      ['Tunai', 'cash', true],
    ]);
  });

  it('idempoten: dijalankan dua kali tidak menggandakan data', async () => {
    const first = await seedDemo(prisma, provider, { ...options, reset: false });
    const before = await counts(first.userId);

    const second = await seedDemo(prisma, provider, { ...options, reset: false });

    expect(second.userId).toBe(first.userId);
    expect(second.seededTransactions).toBe(false);
    expect(second.existingTransactions).toBe(dataset.transactions.length);
    expect(await counts(first.userId)).toEqual(before);
    expect(await prisma.user.count()).toBe(1);
  });

  it('seed ulang setelah pengguna demo dihapus: pesan sisa (user_id NULL) tidak membuat seed gagal', async () => {
    const first = await seedDemo(prisma, provider, { ...options, reset: false });
    await resetUserData(prisma); // seperti menghapus akun demo; message_logs tertinggal dengan user_id NULL
    expect(await prisma.messageLog.count({ where: { userId: null } })).toBe(expectedMessages);
    provider = new FakeAuthProvider(prisma);

    const second = await seedDemo(prisma, provider, { ...options, reset: false });

    expect(second.userId).not.toBe(first.userId);
    expect(second.seededTransactions).toBe(true);
    expect(await prisma.messageLog.count()).toBe(expectedMessages);
    expect((await counts(second.userId)).messages).toBe(expectedMessages);
  });

  it('tidak menimpa transaksi yang ditambahkan pengguna demo', async () => {
    const { userId } = await seedDemo(prisma, provider, { ...options, reset: false });
    const account = await prisma.account.findFirstOrThrow({ where: { userId } });
    const category = await prisma.category.findFirstOrThrow({ where: { userId, type: 'expense' } });
    await prisma.transaction.create({
      data: { userId, accountId: account.id, categoryId: category.id, type: 'expense', amount: 1000, occurredAt: NOW, source: 'manual' },
    });

    await seedDemo(prisma, provider, { ...options, reset: false });

    expect(await prisma.transaction.count({ where: { userId } })).toBe(dataset.transactions.length + 1);
  });

  it('reset: menghapus data demo (termasuk tambahan) lalu mengisi ulang, pengguna tetap sama', async () => {
    const first = await seedDemo(prisma, provider, { ...options, reset: false });
    const account = await prisma.account.findFirstOrThrow({ where: { userId: first.userId } });
    const category = await prisma.category.findFirstOrThrow({ where: { userId: first.userId, type: 'expense' } });
    await prisma.transaction.create({
      data: {
        userId: first.userId,
        accountId: account.id,
        categoryId: category.id,
        type: 'expense',
        amount: 1000,
        description: 'tambahan demo',
        occurredAt: NOW,
        source: 'manual',
      },
    });
    await prisma.account.create({ data: { userId: first.userId, name: 'GoPay', type: 'ewallet' } });

    const second = await seedDemo(prisma, provider, { ...options, reset: true });

    expect(second.userId).toBe(first.userId);
    expect(second.seededTransactions).toBe(true);
    expect(await prisma.transaction.count({ where: { userId: first.userId, description: 'tambahan demo' } })).toBe(0);
    expect(await counts(first.userId)).toEqual({
      transactions: dataset.transactions.length,
      deleted: expectedDeleted,
      messages: expectedMessages,
      audits: dataset.transactions.length + expectedDeleted,
      accounts: 2,
    });
  });

  it('reset tidak menyentuh pengguna lain', async () => {
    await seedDemo(prisma, provider, { ...options, reset: false });
    const { identity } = await provider.signUp({ email: 'lain@example.com', password: 'rahasia-banget-123', fullName: 'Pengguna Lain' });
    await createAuthRepository(prisma).provisionNewUser({ id: identity.id, fullName: 'Pengguna Lain', avatarUrl: null, initialBalance: 0 });
    const account = await prisma.account.findFirstOrThrow({ where: { userId: identity.id } });
    const category = await prisma.category.findFirstOrThrow({ where: { userId: identity.id, type: 'expense' } });
    await prisma.transaction.create({
      data: { userId: identity.id, accountId: account.id, categoryId: category.id, type: 'expense', amount: 5000, occurredAt: NOW, source: 'manual' },
    });

    await seedDemo(prisma, provider, { ...options, reset: true });

    expect(await prisma.transaction.count({ where: { userId: identity.id } })).toBe(1);
    expect(await prisma.account.count({ where: { userId: identity.id } })).toBe(1);
  });

  describe('reset dan tautan WhatsApp', () => {
    const linkWhatsapp = async (userId: string, phone: string) => {
      await prisma.whatsappAccount.create({
        data: {
          userId,
          phoneE164: `+${phone}`,
          waChatId: `${phone}@c.us`,
          status: 'verified',
          verifiedAt: NOW,
        },
      });
      await prisma.whatsappVerification.create({
        data: { userId, phoneE164: `+${phone}`, codeHash: 'hash', expiresAt: new Date(NOW.getTime() + 600_000) },
      });
    };

    const waRows = async (userId: string) => ({
      accounts: await prisma.whatsappAccount.count({ where: { userId } }),
      verifications: await prisma.whatsappVerification.count({ where: { userId } }),
    });

    it('reset membebaskan tautan WhatsApp hasil latihan, sehingga nomornya bisa ditautkan lagi', async () => {
      const { userId } = await seedDemo(prisma, provider, { ...options, reset: false });
      await linkWhatsapp(userId, '628123456789');
      expect(await waRows(userId)).toEqual({ accounts: 1, verifications: 1 });

      await seedDemo(prisma, provider, { ...options, reset: true });

      expect(await waRows(userId)).toEqual({ accounts: 0, verifications: 0 });
      // Unique index parsial (phone_e164) WHERE verified menolak nomor yang sama bila tautan lama masih ada.
      await expect(linkWhatsapp(userId, '628123456789')).resolves.toBeUndefined();
    });

    it('seed biasa (tanpa reset) tidak menyentuh tautan WhatsApp', async () => {
      const { userId } = await seedDemo(prisma, provider, { ...options, reset: false });
      await linkWhatsapp(userId, '628123456789');

      await seedDemo(prisma, provider, { ...options, reset: false });

      expect(await waRows(userId)).toEqual({ accounts: 1, verifications: 1 });
    });

    it('reset tidak menyentuh tautan WhatsApp pengguna lain', async () => {
      await seedDemo(prisma, provider, { ...options, reset: false });
      const { identity } = await provider.signUp({ email: 'lain@example.com', password: 'rahasia-banget-123', fullName: 'Pengguna Lain' });
      await createAuthRepository(prisma).provisionNewUser({ id: identity.id, fullName: 'Pengguna Lain', avatarUrl: null, initialBalance: 0 });
      await linkWhatsapp(identity.id, '628111222333');

      await seedDemo(prisma, provider, { ...options, reset: true });

      expect(await waRows(identity.id)).toEqual({ accounts: 1, verifications: 1 });
    });
  });

  it('akun demo dengan password lain ditolak dengan pesan yang jelas', async () => {
    await provider.signUp({ email: DEMO_EMAIL, password: 'password-lain-123', fullName: 'Orang Lain' });
    await expect(seedDemo(prisma, provider, { ...options, reset: false })).rejects.toThrow(/password-nya bukan/);
  });

  it('konfirmasi email menyala: gagal dengan petunjuk, tidak menulis data', async () => {
    provider.requireEmailConfirmation = true;
    await expect(seedDemo(prisma, provider, { ...options, reset: false })).rejects.toThrow(/konfirmasi email/);
    expect(await prisma.transaction.count()).toBe(0);
  });

  describe('lewat API', () => {
    let server: TestServer;
    let token: string;
    let userId: string;

    beforeEach(async () => {
      userId = (await seedDemo(prisma, provider, { ...options, reset: false })).userId;
      token = (await provider.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD })).session.access_token;
      const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
      server = await startServer(
        createApp({ authService, prisma, verifyAuth: createAuthenticate(provider.verifyAccessToken) }),
      );
    });

    afterEach(async () => {
      await server.close();
    });

    const get = (path: string) => fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    it('transaksi WhatsApp punya source_message; transaksi manual tidak', async () => {
      const whatsapp = await prisma.transaction.findFirstOrThrow({
        where: { userId, source: 'whatsapp', deletedAt: null },
        include: { sourceMessage: true },
      });
      const manual = await prisma.transaction.findFirstOrThrow({ where: { userId, source: 'manual', deletedAt: null } });

      const waBody = await readJson(await get(`/transactions/${whatsapp.id}`));
      expect(waBody.source_message.body).toBe(whatsapp.sourceMessage?.body);
      expect(waBody.source_message.received_at).toEqual(expect.any(String));

      const manualBody = await readJson(await get(`/transactions/${manual.id}`));
      expect(manualBody.source_message).toBeNull();
    });

    it('transaksi yang di-soft-delete tidak muncul dan tidak bisa dibuka', async () => {
      const deleted = await prisma.transaction.findFirstOrThrow({ where: { userId, deletedAt: { not: null } } });
      expect((await get(`/transactions/${deleted.id}`)).status).toBe(404);

      const list = await readJson(await get(`/transactions?limit=100`));
      expect(list.data.map((t: { id: string }) => t.id)).not.toContain(deleted.id);
    });

    it('agregasi bulanan mengabaikan baris soft-delete dan cocok dengan dataset', async () => {
      const summary = createTransactionsSummary(prisma);
      const totals = await summary.sumByType(userId);
      const live = dataset.transactions.filter((t) => !t.deletedAt);
      expect(totals.income).toBe(live.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0));
      expect(totals.expense).toBe(live.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0));
    });
  });
});
