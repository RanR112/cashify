// Integration test penautan nomor WhatsApp (OTP). Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); Supabase diganti FakeAuthProvider dan WhatsApp diganti
// MockGateway, jadi tidak ada pesan sungguhan yang terkirim. Dilewati bila Postgres test tidak menyala.
//
// Antrean outbound diganti penyambung ke MockGateway.sendText: OTP yang "terkirim" dibaca dari
// `gateway.sent`, persis yang akan diterima pemilik nomor.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMockGateway, type MockWhatsAppGateway } from '../../src/gateways/whatsapp/mock.gateway.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import {
  linkPendingSchema,
  linkVerifiedSchema,
  whatsappStatusSchema,
} from '../../src/modules/whatsapp/whatsapp.schema.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');

interface TestUser {
  id: string;
  token: string;
}

const PHONE_A = '+628111111111';
const PHONE_B = '+628222222222';

describe.skipIf(!testDbUrl)('modul whatsapp: penautan nomor (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let provider: FakeAuthProvider;
  let server: TestServer;
  let gateway: MockWhatsAppGateway;
  let a: TestUser;
  let b: TestUser;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function register(email: string): Promise<TestUser> {
    const res = await postJson(`${server.url}/auth/register`, {
      email,
      password: 'rahasia-banget-123',
      full_name: 'Pengguna Uji',
      initial_balance: 0,
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    return { id: body.user.id, token: body.session.access_token };
  }

  beforeEach(async () => {
    await resetUserData(prisma);
    await ensureSystemCategories(prisma);
    provider = new FakeAuthProvider(prisma);
    gateway = createMockGateway();
    const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
    server = await startServer(
      createApp({
        authService,
        prisma,
        verifyAuth: createAuthenticate(provider.verifyAccessToken),
        gateway,
        botSessionId: 'test-bot',
        enqueueOutbound: (message) => gateway.sendText(message.wa_chat_id, message.text),
      }),
    );
    a = await register('ayu@example.com');
    b = await register('budi@example.com');
  });

  afterEach(async () => {
    await server.close();
  });

  function call(method: string, path: string, user?: TestUser, body?: unknown): Promise<Response> {
    return fetch(`${server.url}/whatsapp${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(user && { authorization: `Bearer ${user.token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  const requestLink = (user: TestUser, phone: string) => call('POST', '/link/request', user, { phone });
  const verify = (user: TestUser, code: string) => call('POST', '/link/verify', user, { code });

  /** Kode dari pesan WhatsApp terakhir yang "terkirim" ke bot. */
  function lastCode(): string {
    const message = gateway.sent.at(-1);
    expect(message, 'tidak ada OTP yang terkirim').toBeDefined();
    const match = /\b(\d{6})\b/.exec(message!.body);
    expect(match, 'pesan tidak memuat kode 6 digit').not.toBeNull();
    return match![1]!;
  }

  /** Menautkan nomor sampai terverifikasi. */
  async function link(user: TestUser, phone: string): Promise<void> {
    expect((await requestLink(user, phone)).status).toBe(200);
    expect((await verify(user, lastCode())).status).toBe(200);
  }

  const wrongCode = (real: string) => (real === '000000' ? '000001' : '000000');

  // Memundurkan waktu lewat database: service membaca jam sistem, jadi test menggeser barisnya.
  const backdateVerifications = (userId: string, ms: number) =>
    prisma.$executeRaw`UPDATE whatsapp_verifications
                          SET created_at = created_at - (${ms} * interval '1 millisecond'),
                              expires_at = expires_at - (${ms} * interval '1 millisecond')
                        WHERE user_id = ${userId}::uuid`;

  describe('autentikasi', () => {
    it.each([
      ['GET', '/status'],
      ['POST', '/link/request'],
      ['POST', '/link/verify'],
      ['POST', '/link/resend'],
      ['DELETE', '/link'],
      ['PATCH', '/preferences'],
    ])('%s %s: 401 tanpa token', async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('alur penautan', () => {
    it('belum menaut: status unlinked dengan preferensi mati', async () => {
      const res = await call('GET', '/status', a);
      expect(res.status).toBe(200);
      const body = whatsappStatusSchema.parse(await readJson(res));
      expect(body).toMatchObject({
        status: 'unlinked',
        masked_phone: null,
        expires_at: null,
        verified_at: null,
        last_message_at: null,
        preferences: { daily_summary_enabled: false, budget_alert_enabled: false },
      });
    });

    it('request -> pending -> verify -> verified, lengkap dengan OTP yang dikirim lewat gateway', async () => {
      const requested = await requestLink(a, PHONE_A);
      expect(requested.status).toBe(200);
      const pending = linkPendingSchema.parse(await readJson(requested));
      expect(pending.masked_phone).toBe('+6281111xxxx1');
      const ttl = new Date(pending.expires_at).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000);

      // OTP sampai ke nomor yang diminta, dalam bentuk chat id WhatsApp, dari template di kode.
      expect(gateway.sent).toHaveLength(1);
      expect(gateway.sent[0]!.to).toBe('628111111111@c.us');
      expect(gateway.sent[0]!.body).toContain('Kode verifikasi');

      const status = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(status).toMatchObject({ status: 'pending', masked_phone: '+6281111xxxx1', expires_at: pending.expires_at });

      const verified = await verify(a, lastCode());
      expect(verified.status).toBe(200);
      const body = linkVerifiedSchema.parse(await readJson(verified));
      expect(body.phone).toBe('+6281111xxxx1');

      const after = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(after).toMatchObject({
        status: 'verified',
        masked_phone: '+6281111xxxx1',
        expires_at: null,
        verified_at: body.verified_at,
        preferences: { daily_summary_enabled: false, budget_alert_enabled: false },
      });

      const row = await prisma.whatsappAccount.findFirstOrThrow({ where: { userId: a.id } });
      expect(row).toMatchObject({ status: 'verified', phoneE164: PHONE_A, waChatId: '628111111111@c.us' });
      expect(row.dailySummaryEnabled).toBe(false);
      expect(row.budgetAlertEnabled).toBe(false);
    });

    it('OTP di database berupa hash bcrypt, bukan kode polos', async () => {
      await requestLink(a, PHONE_A);
      const code = lastCode();
      const row = await prisma.whatsappVerification.findFirstOrThrow({ where: { userId: a.id } });
      expect(row.codeHash).toMatch(/^\$2[aby]\$/);
      expect(row.codeHash).not.toBe(code);
      expect(row.codeHash).not.toContain(code);
      expect(row.attempts).toBe(0);
      expect(row.consumedAt).toBeNull();
    });

    it.each([
      ['tanpa kode negara', '08123456789'],
      ['bukan +62', '+14155550123'],
      ['mengandung huruf', '+62abc'],
    ])('nomor tidak valid (%s): 400 dan tidak ada OTP', async (_name, phone) => {
      const res = await requestLink(a, phone);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      expect(gateway.sent).toHaveLength(0);
    });

    it.each(['48392', 'abcdef', '4839201'])('kode "%s" bukan 6 digit: 400', async (code) => {
      await requestLink(a, PHONE_A);
      const res = await verify(a, code);
      expect(res.status).toBe(400);
    });

    it('verify tanpa permintaan yang menunggu: 404', async () => {
      const res = await verify(a, '123456');
      expect(res.status).toBe(404);
      expect((await readJson(res)).error.code).toBe('NOT_FOUND');
    });

    it('sudah terverifikasi lalu request lagi: 409, harus diputus dulu', async () => {
      await link(a, PHONE_A);
      const res = await requestLink(a, PHONE_B);
      expect(res.status).toBe(409);
      expect((await readJson(res)).error.code).toBe('CONFLICT');
    });

    it('request ulang saat pending dengan nomor lain: nomor diganti dan kode lama mati', async () => {
      await requestLink(a, PHONE_A);
      const oldCode = lastCode();
      await requestLink(a, PHONE_B);
      const newCode = lastCode();

      const status = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(status.masked_phone).toBe('+6282222xxxx2');

      if (oldCode !== newCode) {
        expect((await verify(a, oldCode)).status).toBe(400);
      }
      expect((await verify(a, newCode)).status).toBe(200);
      expect(await prisma.whatsappAccount.count({ where: { userId: a.id } })).toBe(1);
    });
  });

  describe('kode salah, percobaan habis, kedaluwarsa, pemakaian ulang', () => {
    it('kode salah: 400 dengan attempts_left menurun 4..0', async () => {
      await requestLink(a, PHONE_A);
      const bad = wrongCode(lastCode());

      for (const expected of [4, 3, 2, 1, 0]) {
        const res = await verify(a, bad);
        expect(res.status).toBe(400);
        const body = await readJson(res);
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details).toEqual([{ field: 'code', issue: 'invalid', attempts_left: expected }]);
      }
    });

    it('lima kali salah memblokir: percobaan ke-6 dan kode yang benar sama-sama 429', async () => {
      await requestLink(a, PHONE_A);
      const real = lastCode();
      const bad = wrongCode(real);
      for (let i = 0; i < 5; i += 1) await verify(a, bad);

      const sixth = await verify(a, bad);
      expect(sixth.status).toBe(429);
      expect((await readJson(sixth)).error.code).toBe('RATE_LIMITED');

      const correct = await verify(a, real);
      expect(correct.status).toBe(429);

      const status = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(status.status).toBe('pending'); // belum terverifikasi
      const row = await prisma.whatsappAccount.findFirstOrThrow({ where: { userId: a.id } });
      expect(row.status).toBe('pending');
    });

    it('setelah diblokir, meminta kode baru (resend) memulihkan', async () => {
      await requestLink(a, PHONE_A);
      const bad = wrongCode(lastCode());
      for (let i = 0; i < 5; i += 1) await verify(a, bad);
      await backdateVerifications(a.id, 61_000); // lewati jeda 60 detik resend

      expect((await call('POST', '/link/resend', a)).status).toBe(200);
      expect((await verify(a, lastCode())).status).toBe(200);
    });

    it('tebakan serentak tidak melewati batas lima percobaan', async () => {
      await requestLink(a, PHONE_A);
      const real = lastCode();
      // 12 tebakan salah sekaligus; yang diterima melewati pemeriksaan "sudah habis" hanya lima.
      const guesses = Array.from({ length: 12 }, (_, i) => String(100_000 + i).padStart(6, '0')).filter((c) => c !== real);
      const results = await Promise.all(guesses.map((code) => verify(a, code)));
      const rejectedAsInvalid = results.filter((r) => r.status === 400).length;
      const blocked = results.filter((r) => r.status === 429).length;
      expect(rejectedAsInvalid).toBeLessThanOrEqual(5);
      expect(rejectedAsInvalid + blocked).toBe(guesses.length);
      const row = await prisma.whatsappVerification.findFirstOrThrow({ where: { userId: a.id } });
      expect(row.attempts).toBe(5);
    });

    it('kode kedaluwarsa: 404, status kembali unlinked, request baru memulihkan', async () => {
      await requestLink(a, PHONE_A);
      const code = lastCode();
      await prisma.whatsappVerification.updateMany({
        where: { userId: a.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await verify(a, code);
      expect(res.status).toBe(404);
      expect((await readJson(res)).error.code).toBe('NOT_FOUND');
      expect(whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a))).status).toBe('unlinked');

      expect((await requestLink(a, PHONE_A)).status).toBe(200);
      expect((await verify(a, lastCode())).status).toBe(200);
    });

    it('kode yang sudah dipakai tidak bisa dipakai lagi (consumed_at)', async () => {
      await requestLink(a, PHONE_A);
      const code = lastCode();
      expect((await verify(a, code)).status).toBe(200);

      const again = await verify(a, code);
      expect(again.status).toBe(404);

      const row = await prisma.whatsappVerification.findFirstOrThrow({ where: { userId: a.id } });
      expect(row.consumedAt).not.toBeNull();
    });

    it('kode benar yang dikirim serentak hanya berhasil sekali', async () => {
      await requestLink(a, PHONE_A);
      const code = lastCode();
      const results = await Promise.all([verify(a, code), verify(a, code), verify(a, code)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await prisma.whatsappAccount.count({ where: { userId: a.id, status: 'verified' } })).toBe(1);
    });
  });

  describe('nomor sudah dipakai', () => {
    it('nomor terverifikasi akun lain: 409 saat request, tanpa OTP dan tanpa baris baru', async () => {
      await link(a, PHONE_A);
      gateway.sent.length = 0;

      const res = await requestLink(b, PHONE_A);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error.code).toBe('CONFLICT');
      expect(JSON.stringify(body)).not.toContain(a.id); // tidak membocorkan siapa pemiliknya
      expect(gateway.sent).toHaveLength(0);
      expect(await prisma.whatsappVerification.count({ where: { userId: b.id } })).toBe(0);
    });

    it('dua pengguna menunggu nomor yang sama: yang pertama memverifikasi menang, yang kedua 409', async () => {
      await requestLink(a, PHONE_A);
      const codeA = lastCode();
      await requestLink(b, PHONE_A); // sah: belum ada yang terverifikasi
      const codeB = lastCode();

      expect((await verify(b, codeB)).status).toBe(200);

      const late = await verify(a, codeA);
      expect(late.status).toBe(409);
      expect((await readJson(late)).error.code).toBe('CONFLICT');

      // Pemenang tetap utuh dan yang kalah tidak ikut terverifikasi.
      expect(await prisma.whatsappAccount.count({ where: { phoneE164: PHONE_A, status: 'verified' } })).toBe(1);
      const loser = await prisma.whatsappAccount.findFirstOrThrow({ where: { userId: a.id } });
      expect(loser.status).toBe('pending');
    });
  });

  describe('batas harian', () => {
    it('3 per nomor per hari: permintaan ke-4 untuk nomor yang sama 429 dengan retry_after_seconds', async () => {
      for (let i = 0; i < 3; i += 1) expect((await requestLink(a, PHONE_A)).status).toBe(200);

      const res = await requestLink(a, PHONE_A);
      expect(res.status).toBe(429);
      const body = await readJson(res);
      expect(body.error.code).toBe('RATE_LIMITED');
      const retry = body.error.details[0].retry_after_seconds as number;
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(24 * 3600);
      expect(gateway.sent).toHaveLength(3);
    });

    it('batas per nomor berlaku lintas pengguna (melindungi pemilik nomor dari spam)', async () => {
      // Pendaftaran dibatasi 3 per jam per IP (a, b, dan c); jadi dua permintaan dari a, satu dari b.
      const c = await register('c@example.com');
      for (const user of [a, a, b]) expect((await requestLink(user, PHONE_A)).status).toBe(200);

      const res = await requestLink(c, PHONE_A);
      expect(res.status).toBe(429);
      expect(gateway.sent).toHaveLength(3);
    });

    it('5 per pengguna per hari: permintaan ke-6 429 meski nomornya berbeda', async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await requestLink(a, `+62833333333${i}`)).status).toBe(200);
      }
      const res = await requestLink(a, '+628444444444');
      expect(res.status).toBe(429);
      expect((await readJson(res)).error.details[0].retry_after_seconds).toBeGreaterThan(0);
      expect(gateway.sent).toHaveLength(5);
    });

    it('OTP yang lebih tua dari 24 jam tidak dihitung', async () => {
      for (let i = 0; i < 3; i += 1) await requestLink(a, PHONE_A);
      expect((await requestLink(a, PHONE_A)).status).toBe(429);

      await backdateVerifications(a.id, 25 * 3600 * 1000);
      expect((await requestLink(a, PHONE_A)).status).toBe(200);
    });
  });

  describe('resend', () => {
    it('tanpa permintaan yang menunggu: 404', async () => {
      const res = await call('POST', '/link/resend', a);
      expect(res.status).toBe(404);
    });

    it('kurang dari 60 detik sejak kiriman terakhir: 429, tanpa OTP baru', async () => {
      await requestLink(a, PHONE_A);
      const res = await call('POST', '/link/resend', a);
      expect(res.status).toBe(429);
      const retry = (await readJson(res)).error.details[0].retry_after_seconds as number;
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(60);
      expect(gateway.sent).toHaveLength(1);
    });

    it('setelah 60 detik: kode baru terkirim ke nomor yang sama, kode lama tidak lagi berlaku', async () => {
      await requestLink(a, PHONE_A);
      const first = lastCode();
      await backdateVerifications(a.id, 61_000);

      const res = await call('POST', '/link/resend', a);
      expect(res.status).toBe(200);
      linkPendingSchema.parse(await readJson(res));
      expect(gateway.sent).toHaveLength(2);
      expect(gateway.sent[1]!.to).toBe('628111111111@c.us');

      const second = lastCode();
      if (first !== second) expect((await verify(a, first)).status).toBe(400);
      expect((await verify(a, second)).status).toBe(200);
    });

    it('dihitung ke batas harian per nomor', async () => {
      await requestLink(a, PHONE_A);
      for (let i = 0; i < 2; i += 1) {
        await backdateVerifications(a.id, 61_000);
        expect((await call('POST', '/link/resend', a)).status).toBe(200);
      }
      await backdateVerifications(a.id, 61_000);
      expect((await call('POST', '/link/resend', a)).status).toBe(429);
    });
  });

  describe('sesi bot terputus', () => {
    it('request: 503 SERVICE_UNAVAILABLE, tanpa OTP, tanpa baris, kuota tidak terpakai', async () => {
      gateway.setConnected(false);
      const res = await requestLink(a, PHONE_A);
      expect(res.status).toBe(503);
      const body = await readJson(res);
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.message).toMatch(/bukan kesalahan Anda/i);

      expect(gateway.sent).toHaveLength(0);
      expect(await prisma.whatsappVerification.count({ where: { userId: a.id } })).toBe(0);
      expect(await prisma.whatsappAccount.count({ where: { userId: a.id } })).toBe(0);
    });

    it('resend: 503 bila terputus', async () => {
      await requestLink(a, PHONE_A);
      await backdateVerifications(a.id, 61_000);
      // Monitor menyimpan status 10 detik; app baru untuk melihat status yang berubah.
      await server.close();
      gateway.setConnected(false);
      const authService = createAuthService({ provider, repository: createAuthRepository(prisma) });
      server = await startServer(
        createApp({
          authService,
          prisma,
          verifyAuth: createAuthenticate(provider.verifyAccessToken),
          gateway,
          botSessionId: 'test-bot',
          enqueueOutbound: (message) => gateway.sendText(message.wa_chat_id, message.text),
        }),
      );
      const res = await call('POST', '/link/resend', a);
      expect(res.status).toBe(503);
    });

    it('status sesi dicatat di whatsapp_sessions', async () => {
      gateway.setConnected(false);
      await requestLink(a, PHONE_A);
      const row = await prisma.whatsappSession.findUniqueOrThrow({ where: { sessionId: 'test-bot' } });
      expect(row.status).toBe('disconnected');
      expect(row.lastError).toContain('terputus');
    });

    it('status dan preferences tidak butuh sesi bot', async () => {
      gateway.setConnected(false);
      expect((await call('GET', '/status', a)).status).toBe(200);
    });
  });

  describe('pemutusan tautan', () => {
    it('DELETE: 204, baris tetap ada dengan status disabled, ulang 404', async () => {
      await link(a, PHONE_A);

      const res = await call('DELETE', '/link', a);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');

      const row = await prisma.whatsappAccount.findFirstOrThrow({ where: { userId: a.id } });
      expect(row.status).toBe('disabled');
      expect(row.phoneE164).toBe(PHONE_A);
      expect(whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a))).status).toBe('unlinked');

      expect((await call('DELETE', '/link', a)).status).toBe(404);
    });

    it('menaut ulang nomor yang sama mengulang OTP dari awal; riwayat disabled tetap ada', async () => {
      await link(a, PHONE_A);
      await call('DELETE', '/link', a);
      gateway.sent.length = 0;

      expect((await requestLink(a, PHONE_A)).status).toBe(200);
      expect(gateway.sent).toHaveLength(1);
      // Belum terverifikasi sebelum OTP baru dimasukkan.
      expect(whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a))).status).toBe('pending');
      expect((await verify(a, lastCode())).status).toBe(200);

      const rows = await prisma.whatsappAccount.findMany({ where: { userId: a.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.status)).toEqual(['disabled', 'verified']);
    });

    it('nomor yang diputus bisa dipakai akun lain', async () => {
      await link(a, PHONE_A);
      await call('DELETE', '/link', a);
      await link(b, PHONE_A);
      expect(await prisma.whatsappAccount.count({ where: { phoneE164: PHONE_A, status: 'verified' } })).toBe(1);
    });

    it('memutus saat masih pending: 204, dan kode yang beredar tidak lagi bisa dipakai', async () => {
      await requestLink(a, PHONE_A);
      const code = lastCode();
      expect((await call('DELETE', '/link', a)).status).toBe(204);
      expect((await verify(a, code)).status).toBe(404);
    });

    it('tanpa tautan aktif: 404', async () => {
      expect((await call('DELETE', '/link', a)).status).toBe(404);
    });
  });

  describe('preferences', () => {
    it('404 selama belum terverifikasi (unlinked maupun pending)', async () => {
      expect((await call('PATCH', '/preferences', a, { daily_summary_enabled: true })).status).toBe(404);
      await requestLink(a, PHONE_A);
      expect((await call('PATCH', '/preferences', a, { daily_summary_enabled: true })).status).toBe(404);
    });

    it('mengubah sebagian field dan mengembalikan bentuk status', async () => {
      await link(a, PHONE_A);

      const first = await call('PATCH', '/preferences', a, { daily_summary_enabled: true });
      expect(first.status).toBe(200);
      expect(whatsappStatusSchema.parse(await readJson(first)).preferences).toEqual({
        daily_summary_enabled: true,
        budget_alert_enabled: false,
      });

      const second = await call('PATCH', '/preferences', a, { budget_alert_enabled: true });
      expect(whatsappStatusSchema.parse(await readJson(second)).preferences).toEqual({
        daily_summary_enabled: true,
        budget_alert_enabled: true,
      });

      const status = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(status.preferences).toEqual({ daily_summary_enabled: true, budget_alert_enabled: true });
    });

    it.each([
      ['body kosong', {}],
      ['bukan boolean', { daily_summary_enabled: 'ya' }],
    ])('400: %s', async (_name, body) => {
      await link(a, PHONE_A);
      const res = await call('PATCH', '/preferences', a, body);
      expect(res.status).toBe(400);
    });

    it('menaut ulang setelah diputus: preferensi kembali mati', async () => {
      await link(a, PHONE_A);
      await call('PATCH', '/preferences', a, { daily_summary_enabled: true, budget_alert_enabled: true });
      await call('DELETE', '/link', a);
      await link(a, PHONE_A);

      const status = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(status.preferences).toEqual({ daily_summary_enabled: false, budget_alert_enabled: false });
    });
  });

  describe('isolasi antar-pengguna', () => {
    it('data A tidak terlihat dan tidak tersentuh oleh B', async () => {
      await link(a, PHONE_A);
      await call('PATCH', '/preferences', a, { daily_summary_enabled: true });

      // B tidak melihat apa pun milik A.
      const status = await call('GET', '/status', b);
      const text = JSON.stringify(await readJson(status));
      expect(text).toContain('unlinked');
      expect(text).not.toContain('6281111');

      // B tidak bisa memutus, mengubah preferensi, atau meminta resend atas nama A.
      expect((await call('DELETE', '/link', b)).status).toBe(404);
      expect((await call('PATCH', '/preferences', b, { daily_summary_enabled: false })).status).toBe(404);
      expect((await call('POST', '/link/resend', b)).status).toBe(404);
      expect((await verify(b, '123456')).status).toBe(404);

      // user_id di body diabaikan: identitas hanya dari JWT (aturan 8).
      const spoof = await call('POST', '/link/request', b, { phone: PHONE_B, user_id: a.id });
      expect(spoof.status).toBe(200);
      expect(await prisma.whatsappAccount.count({ where: { userId: a.id } })).toBe(1);
      expect(await prisma.whatsappVerification.count({ where: { userId: a.id } })).toBe(1);

      // A tetap terverifikasi dengan preferensinya.
      const after = whatsappStatusSchema.parse(await readJson(await call('GET', '/status', a)));
      expect(after).toMatchObject({
        status: 'verified',
        preferences: { daily_summary_enabled: true, budget_alert_enabled: false },
      });
    });

    it('kode milik B tidak bisa dipakai A', async () => {
      await requestLink(a, PHONE_A);
      await requestLink(b, PHONE_B);
      const codeB = lastCode();
      const codeA = gateway.sent[0]!.body.match(/\b(\d{6})\b/)![1]!;

      if (codeB !== codeA) expect((await verify(a, codeB)).status).toBe(400);
      expect((await call('GET', '/status', b)).status).toBe(200);
      expect(await prisma.whatsappAccount.count({ where: { userId: b.id, status: 'verified' } })).toBe(0);
    });
  });
});
