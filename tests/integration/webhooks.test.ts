// Integration test penerima webhook OpenWA. Express nyata + Prisma nyata ke Postgres test
// (docker compose up -d postgres-test); antrean diganti perekam, kecuali satu varian yang memakai
// BullMQ + Redis asli (docker compose up -d redis). Dilewati bila layanannya tidak menyala.
// Kontrak: claude/API.md bagian 9. Payload: tests/fixtures/openwa/ (rekaman v4 nyata, disamarkan).
//
// Yang dikunci di sini: idempotency (webhook sama dua kali = satu baris, satu job), pesan yang
// tidak boleh diproses (fromMe, grup, ciphertext, event lain), dan temuan spike P0 bahwa
// `ciphertext` datang dengan id yang SAMA dengan pesan aslinya.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAuthService } from '../../src/modules/auth/auth.service.js';
import { createQueues, enqueueInbound, type InboundJobData, type Queues } from '../../src/queues/index.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';
import { dmWithId, openwaFixture, type OpenWaEnvelope } from '../helpers/openwaFixtures.js';
import { createTestPrisma, FakeAuthProvider } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const testDbUrl = inject('testDbUrl');
const testRedisUrl = inject('testRedisUrl');

const SECRET = 'a7f2k9m3q1b8x5c4v6n2d0e1f3g7h9j2';
const PATH = '/webhooks/openwa';

describe.skipIf(!testDbUrl)('webhook OpenWA (integrasi, Postgres test)', () => {
  let prisma: PrismaClient;
  let server: TestServer;
  let enqueued: InboundJobData[];
  let failEnqueue: boolean;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function startApp(enqueue?: (data: InboundJobData) => Promise<unknown>): Promise<TestServer> {
    const provider = new FakeAuthProvider(prisma);
    return startServer(
      createApp({
        prisma,
        authService: createAuthService({ provider, repository: createAuthRepository(prisma) }),
        verifyAuth: createAuthenticate(provider.verifyAccessToken),
        webhookSecret: SECRET,
        enqueueInbound:
          enqueue ??
          (async (data) => {
            if (failEnqueue) throw new Error('Redis tidak dapat dihubungi');
            enqueued.push(data);
          }),
      }),
    );
  }

  beforeEach(async () => {
    await prisma.messageLog.deleteMany();
    enqueued = [];
    failEnqueue = false;
    server = await startApp();
  });

  afterEach(async () => {
    await server.close();
  });

  const send = (body: object | string, secret = SECRET) => postJson(`${server.url}${PATH}/${secret}`, body);
  const rows = () => prisma.messageLog.findMany();

  describe('idempotency (aturan 5)', () => {
    it('webhook yang sama dua kali: dua 204, SATU baris, SATU job', async () => {
      const payload = openwaFixture('dm-on-message');

      const first = await send(payload);
      const second = await send(payload);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      const saved = await rows();
      expect(saved).toHaveLength(1);
      expect(enqueued).toEqual([{ message_log_id: saved[0]!.id }]);
    });

    it('kiriman ulang yang datang bersamaan tetap menghasilkan satu baris dan satu job', async () => {
      const payload = openwaFixture('dm-on-message');

      const responses = await Promise.all(Array.from({ length: 8 }, () => send(payload)));

      expect(responses.every((res) => res.status === 204)).toBe(true);
      expect(await rows()).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
    });

    it('pesan berbeda masing-masing tersimpan dan masuk antrean', async () => {
      await send(dmWithId('false_111111111111111@lid_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1'));
      await send(dmWithId('false_111111111111111@lid_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2'));

      expect(await rows()).toHaveLength(2);
      expect(enqueued).toHaveLength(2);
    });

    it('sesi berbeda dengan id pesan sama dianggap pesan berbeda (kuncinya session_id + wa_message_id)', async () => {
      const a = openwaFixture('dm-on-message');
      const b = openwaFixture('dm-on-message');
      b['sessionId'] = 'sesi-lain';

      await send(a);
      await send(b);

      expect(await rows()).toHaveLength(2);
    });

    it('REGRESI P0: ciphertext lalu chat dengan data.id yang sama => pesan asli tetap tersimpan', async () => {
      // Di rekaman nyata (grup), ciphertext berisi kosong datang ~550 ms sebelum pesan aslinya,
      // dengan data.id yang identik. Bila ciphertext ikut disimpan, unique index membuang pesan asli.
      const ciphertext = openwaFixture('dm-on-message');
      ciphertext.data['type'] = 'ciphertext';
      ciphertext.data['body'] = '';
      const real = openwaFixture('dm-on-message');
      expect(ciphertext.data['id']).toBe(real.data['id']);

      expect((await send(ciphertext)).status).toBe(204);
      expect(await rows()).toHaveLength(0);
      expect(enqueued).toHaveLength(0);

      expect((await send(real)).status).toBe(204);
      const saved = await rows();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ messageType: 'chat', body: 'tadi makan siang 25 ribu' });
      expect(enqueued).toHaveLength(1);
    });
  });

  describe('pesan yang diterima', () => {
    it('menyimpan pesan mentah dengan status received, tanpa pengguna, dan memasukkan ID saja ke antrean', async () => {
      const res = await send(openwaFixture('dm-on-message'));

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      const [row, ...rest] = await rows();
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        userId: null,
        sessionId: 'session',
        waMessageId: 'false_111111111111111@lid_AC0D70512C16BC6E88D19BAF13A5F557',
        waChatId: '111111111111111@lid',
        direction: 'inbound',
        messageType: 'chat',
        body: 'tadi makan siang 25 ribu',
        status: 'received',
        processedAt: null,
      });
      expect(row!.correlationId).toBe(openwaFixture('dm-on-message')['id']);
      // Antrean hanya menerima ID, bukan payload (sumber kebenaran tetap di database).
      expect(enqueued).toEqual([{ message_log_id: row!.id }]);
    });

    it('menyimpan amplop utuh di raw_payload; nomor pengirim ada di sender.phoneNumber, bukan di from', async () => {
      await send(openwaFixture('dm-on-message'));

      const [row] = await rows();
      const raw = row!.rawPayload as OpenWaEnvelope;
      expect(raw['event']).toBe('onMessage');
      expect(raw.data['from']).toBe('111111111111111@lid');
      expect(raw.data['sender'].phoneNumber).toBe('628123456789@c.us');
    });

    it('gambar: tipe tersimpan, body null (body OpenWA adalah thumbnail base64, bukan teks)', async () => {
      await send(openwaFixture('image-on-message'));

      const [row] = await rows();
      expect(row).toMatchObject({ messageType: 'image', body: null, status: 'received' });
      expect(enqueued).toHaveLength(1);
    });

    it('gambar dengan keterangan: yang disimpan keterangannya', async () => {
      const image = openwaFixture('image-on-message');
      image.data['caption'] = 'struk belanja 45 ribu';

      await send(image);

      expect((await rows())[0]).toMatchObject({ messageType: 'image', body: 'struk belanja 45 ribu' });
    });

    it('selesai di bawah 100 ms (aturan 4): median 7 permintaan', async () => {
      await send(dmWithId('false_111111111111111@lid_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB0')); // pemanasan koneksi

      const durations: number[] = [];
      for (let i = 1; i <= 7; i += 1) {
        const payload = dmWithId(`false_111111111111111@lid_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB${i}`);
        const start = performance.now();
        const res = await send(payload);
        durations.push(performance.now() - start);
        expect(res.status).toBe(204);
      }
      durations.sort((x, y) => x - y);
      expect(durations[3]!).toBeLessThan(100);
    });
  });

  describe('diabaikan: 204 tanpa baris dan tanpa job', () => {
    const expectNoEffect = async () => {
      expect(await rows()).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    };

    it('fromMe: true (aturan 6)', async () => {
      const payload = openwaFixture('dm-on-message');
      payload.data['fromMe'] = true;

      expect((await send(payload)).status).toBe(204);
      await expectNoEffect();
    });

    it('onAnyMessage (pasangan onMessage dengan id sama) dan onAck', async () => {
      for (const name of ['dm-on-any-message', 'bot-reply-on-any-message', 'bot-reply-on-ack'] as const) {
        expect((await send(openwaFixture(name))).status, name).toBe(204);
      }
      await expectNoEffect();
    });

    it('event tidak dikenal, termasuk yang `data`-nya bukan objek', async () => {
      for (const data of ['CONNECTED', 42, null, { state: 'TIMEOUT' }]) {
        const res = await send({ event: 'onStateChanged', sessionId: 'session', data });
        expect(res.status).toBe(204);
      }
      await expectNoEffect();
    });

    it('pesan grup, baik ciphertext maupun chat', async () => {
      expect((await send(openwaFixture('group-ciphertext-on-message'))).status).toBe(204);
      expect((await send(openwaFixture('group-chat-on-message'))).status).toBe(204);
      await expectNoEffect();
    });
  });

  describe('keamanan', () => {
    it('rahasia salah => 401 dan tanpa efek, termasuk untuk payload yang valid', async () => {
      const res = await send(openwaFixture('dm-on-message'), 'rahasia-yang-salah-sama-sekali');

      expect(res.status).toBe(401);
      expect((await readJson(res)).error.code).toBe('UNAUTHORIZED');
      expect(await rows()).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    });

    it('rahasia dengan panjang berbeda jauh => 401, bukan 500', async () => {
      expect((await send(openwaFixture('dm-on-message'), 'x')).status).toBe(401);
      expect((await send(openwaFixture('dm-on-message'), 'x'.repeat(2000))).status).toBe(401);
    });

    it('rahasia salah mendahului pemeriksaan body: JSON rusak tetap 401', async () => {
      expect((await send('{ ini bukan json', 'rahasia-yang-salah-sama-sekali')).status).toBe(401);
    });

    it('tanpa segmen rahasia sama sekali => tidak sampai ke handler', async () => {
      const res = await postJson(`${server.url}${PATH}`, openwaFixture('dm-on-message'));

      expect(res.status).toBe(404);
      expect(await rows()).toHaveLength(0);
    });

    it('tidak ada header rahasia yang dibutuhkan: OpenWA v4 tidak bisa mengirimnya', async () => {
      // Permintaan polos tanpa header kustom, persis seperti kiriman axios dari OpenWA.
      const res = await fetch(`${server.url}${PATH}/${SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'axios/1.20.0' },
        body: JSON.stringify(openwaFixture('dm-on-message')),
      });
      expect(res.status).toBe(204);
    });
  });

  describe('payload rusak => 400 tanpa efek', () => {
    const expectRejected = async (body: object | string) => {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error.code).toBe('VALIDATION_ERROR');
      expect(await rows()).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    };

    it('bukan JSON', async () => {
      await expectRejected('{ ini bukan json');
    });

    it('body kosong', async () => {
      await expectRejected('');
    });

    it('JSON valid tetapi bukan amplop (array, tanpa event, tanpa sessionId)', async () => {
      await expectRejected('[]');
      await expectRejected('"onMessage"');
      await expectRejected(JSON.stringify({ sessionId: 'session', data: {} }));
      await expectRejected(JSON.stringify({ event: 'onMessage', data: {} }));
    });

    it('onMessage dengan data yang bukan pesan', async () => {
      await expectRejected({ event: 'onMessage', sessionId: 'session', data: { body: 'tanpa id' } });
      await expectRejected({ event: 'onMessage', sessionId: 'session', data: 'bukan objek' });
      await expectRejected({ event: 'onMessage', sessionId: 'session' });
    });

    it('body lebih besar dari batas', async () => {
      const huge = openwaFixture('dm-on-message');
      huge.data['body'] = 'x'.repeat(3 * 1024 * 1024);
      await expectRejected(huge);
    });
  });

  describe('ketahanan', () => {
    it('antrean gagal: tetap 204, dan barisnya ditandai failed (tidak menggantung di received)', async () => {
      failEnqueue = true;

      const res = await send(openwaFixture('dm-on-message'));

      expect(res.status).toBe(204);
      await vi.waitFor(async () => {
        expect((await rows())[0]).toMatchObject({ status: 'failed', error: 'enqueue_failed' });
      });
    });

    it('120 permintaan beruntun lolos semua: router dipasang di luar pembatas global 100/menit', async () => {
      const statuses = new Set<number>();
      for (let i = 0; i < 120; i += 1) {
        statuses.add((await send(openwaFixture('dm-on-any-message'))).status);
      }
      expect([...statuses]).toEqual([204]);
    });

    it('rute lain tetap kena pembatas global dan express.json (webhook tidak membuka jalan pintas)', async () => {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe('100');
    });
  });
});

describe.skipIf(!testDbUrl || !testRedisUrl)('webhook OpenWA dengan BullMQ + Redis asli', () => {
  let prisma: PrismaClient;
  let connection: Redis;
  let queues: Queues;
  let server: TestServer;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.messageLog.deleteMany();
    connection = new Redis(testRedisUrl, { maxRetriesPerRequest: null });
    // Awalan unik: aman dijalankan pada Redis pengembangan.
    queues = createQueues(connection, { prefix: `test-${randomUUID()}` });
    const provider = new FakeAuthProvider(prisma);
    server = await startServer(
      createApp({
        prisma,
        authService: createAuthService({ provider, repository: createAuthRepository(prisma) }),
        verifyAuth: createAuthenticate(provider.verifyAccessToken),
        webhookSecret: SECRET,
        enqueueInbound: (data) => enqueueInbound(queues.inbound, data),
      }),
    );
  });

  afterEach(async () => {
    await server.close();
    await queues.inbound.obliterate({ force: true });
    await Promise.all([queues.inbound.close(), queues.outbound.close()]);
    await connection.quit();
  });

  it('webhook yang sama dua kali: SATU baris message_logs dan SATU job di antrean inbound', async () => {
    const url = `${server.url}${PATH}/${SECRET}`;
    const payload = openwaFixture('dm-on-message');

    expect((await postJson(url, payload)).status).toBe(204);
    expect((await postJson(url, payload)).status).toBe(204);

    const saved = await prisma.messageLog.findMany();
    expect(saved).toHaveLength(1);

    // Tanpa worker, job menunggu di antrean. Hitung semua keadaan supaya job yang lolos tidak terlewat.
    const counts = await queues.inbound.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized', 'waiting-children');
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(1);
    const [job] = await queues.inbound.getJobs(['waiting']);
    expect(job?.data).toEqual({ message_log_id: saved[0]!.id });
  });
});
