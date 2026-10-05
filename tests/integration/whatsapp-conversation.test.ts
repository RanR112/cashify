// Integration test alur percakapan WhatsApp (P15): pesan masuk -> konfirmasi -> ya/batal -> transaksi.
// Postgres test + Redis + BullMQ ASLI (docker compose up -d postgres-test redis); WhatsApp diganti
// MockGateway, jadi tidak ada pesan sungguhan yang terkirim. Dilewati bila salah satunya tidak menyala.
//
// Yang berjalan di sini persis yang berjalan di src/worker.ts: `createInboundPipeline` (pemroses +
// percakapan + repository/service asli), worker inbound dan outbound sungguhan. Satu-satunya yang
// diganti: gateway (mock) dan jeda acak 2-5 detik (dimatikan; jedanya sendiri diuji di queues.test.ts).
//
// Balasan dibaca dari `gateway.sent`, yaitu yang akan diterima pengguna.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { createMockGateway, type MockWhatsAppGateway } from '../../src/gateways/whatsapp/mock.gateway.js';
import { pendingKey } from '../../src/lib/pendingState.js';
import { userLockKey } from '../../src/lib/userLock.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createWebhooksRepository } from '../../src/modules/webhooks/webhooks.repository.js';
import { toJakartaDate } from '../../src/shared/utils/timezone.js';
import { createQueues, enqueueInbound, enqueueOutbound, type Queues } from '../../src/queues/index.js';
import { startWorkers, type StartedWorkers } from '../../src/workers/index.js';
import { inviteKey } from '../../src/workers/inbound.processor.js';
import { createInboundPipeline, type InboundPipeline } from '../../src/workers/pipeline.js';
import { openwaFixture } from '../helpers/openwaFixtures.js';
import { createTestPrisma, ensureSystemCategories, FakeAuthProvider, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const testDbUrl = inject('testDbUrl');
const testRedisUrl = inject('testRedisUrl');

/** Cocok dengan `sender.phoneNumber` di fixture dm-on-message. */
const PHONE_CHAT = '628123456789@c.us';
const STRANGER_CHAT = '628999999999@c.us';
const OTHER_STRANGER_CHAT = '628777777777@c.us';
/** Kunci ajakan daftar bertahan 24 jam di Redis; dibersihkan sebelum dan sesudah tiap test. */
const INVITE_CHATS = [PHONE_CHAT, STRANGER_CHAT, OTHER_STRANGER_CHAT];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timeout menunggu: ${what}`);
    await sleep(25);
  }
}

interface ReceiveOptions {
  /** Detik sejak epoch, seperti `data.timestamp` OpenWA. Bawaan: waktu sekarang + urutan. */
  timestamp?: number;
  type?: string;
  /** `sender.phoneNumber`; bawaan nomor pengguna uji. */
  from?: string;
}

describe.skipIf(!testDbUrl || !testRedisUrl)('alur percakapan WhatsApp (integrasi, Postgres + Redis + BullMQ)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let connection: Redis;
  let queues: Queues;
  let workers: StartedWorkers;
  let pipeline: InboundPipeline;
  let gateway: MockWhatsAppGateway;
  let userId: string;
  let seq: number;
  const baseTimestamp = Math.floor(Date.now() / 1000) - 60;

  beforeAll(() => {
    prisma = createTestPrisma(testDbUrl);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Pengguna dengan akun default, kategori salinan, dan nomor WhatsApp terverifikasi. */
  async function createUser(): Promise<string> {
    const provider = new FakeAuthProvider(prisma);
    const { identity } = await provider.signUp({
      email: `uji-${randomUUID()}@example.com`,
      password: 'rahasia-banget-123',
      fullName: 'Pengguna Uji',
    });
    await createAuthRepository(prisma).provisionNewUser({
      id: identity.id,
      fullName: 'Pengguna Uji',
      avatarUrl: null,
      initialBalance: 0,
    });
    await prisma.whatsappAccount.create({
      data: {
        userId: identity.id,
        phoneE164: '+628123456789',
        waChatId: PHONE_CHAT,
        status: 'verified',
        verifiedAt: new Date(),
      },
    });
    return identity.id;
  }

  async function startPipeline(overrides: { disconnectedDelayMs?: number } = {}): Promise<void> {
    const prefix = `test-${randomUUID()}`;
    connection = new Redis(testRedisUrl, { maxRetriesPerRequest: null });
    redis = new Redis(testRedisUrl, { maxRetriesPerRequest: 3 });
    queues = createQueues(connection, { prefix });
    gateway = createMockGateway();

    pipeline = createInboundPipeline({
      prisma,
      redis,
      enqueueReply: (request) =>
        enqueueOutbound(
          queues.outbound,
          { wa_chat_id: request.to, text: request.text, message_log_id: request.messageLogId },
          { jobId: `reply-${request.messageLogId}` },
        ),
    });
    workers = startWorkers(connection, {
      prefix,
      inbound: { processor: pipeline.processor, onExhausted: pipeline.markInboundFailed },
      outbound: {
        send: (data) => gateway.sendText(data.wa_chat_id, data.text),
        pause: async () => undefined, // jeda acak 2-5 detik dimatikan; diuji di queues.test.ts
        isConnected: async () => (await gateway.getStatus()).connected,
        onExhausted: pipeline.recordReplyFailure,
        disconnectedDelayMs: overrides.disconnectedDelayMs ?? 100,
      },
    });
    await workers.ready();
  }

  beforeEach(async () => {
    await resetUserData(prisma);
    await prisma.messageLog.deleteMany();
    await ensureSystemCategories(prisma);
    userId = await createUser();
    seq = 0;
    await startPipeline();
    await redis.del(...INVITE_CHATS.map(inviteKey));
  });

  afterEach(async () => {
    await workers.close();
    await Promise.all([queues.inbound.obliterate({ force: true }), queues.outbound.obliterate({ force: true })]);
    await Promise.all([queues.inbound.close(), queues.outbound.close()]);
    await redis.del(pendingKey(userId), userLockKey(userId), ...INVITE_CHATS.map(inviteKey));
    await redis.quit();
    await connection.quit();
  });

  // ---- pembantu ----

  const webhooks = () => createWebhooksRepository(prisma);

  /** Menyimpan pesan seperti penerima webhook (tanpa antrean). Mengembalikan message_logs.id. */
  async function store(body: string, { timestamp, type = 'chat', from = PHONE_CHAT }: ReceiveOptions = {}): Promise<string> {
    seq += 1;
    const at = timestamp ?? baseTimestamp + seq;
    const envelope = openwaFixture('dm-on-message');
    const waMessageId = `false_111111111111111@lid_TEST${String(seq).padStart(28, '0')}`;
    Object.assign(envelope.data, { id: waMessageId, body, type, timestamp: at, t: at });
    envelope.data.sender.phoneNumber = from;
    // LID berbeda per pengirim, seperti WhatsApp sungguhan.
    if (from !== PHONE_CHAT) envelope.data.chatId = '222222222222222@lid';

    const id = await webhooks().insertReceived({
      sessionId: envelope.sessionId,
      waMessageId,
      waChatId: envelope.data.chatId,
      messageType: type,
      body,
      rawPayload: envelope,
      correlationId: null,
    });
    expect(id, 'pesan tidak tersimpan').not.toBeNull();
    return id as string;
  }

  const enqueue = (messageLogId: string) => enqueueInbound(queues.inbound, { message_log_id: messageLogId });

  /** Pesan masuk: tersimpan lalu diantrekan. */
  async function receive(body: string, options?: ReceiveOptions): Promise<string> {
    const id = await store(body, options);
    await enqueue(id);
    return id;
  }

  /** Menunggu sampai `gateway.sent` berisi `count` balasan, lalu mengembalikan yang terakhir. */
  async function nextReply(count: number): Promise<string> {
    await waitFor(() => gateway.sent.length >= count, 8000, `${count} balasan terkirim (ada ${gateway.sent.length})`);
    return gateway.sent[count - 1]!.body;
  }

  const transactions = () => prisma.transaction.findMany({ include: { category: true }, orderBy: { createdAt: 'asc' } });
  const messageStatus = async (id: string) => (await prisma.messageLog.findUniqueOrThrow({ where: { id } })).status;

  /** Mengirim satu pesan dan menunggu balasannya. */
  async function say(body: string, options?: ReceiveOptions): Promise<string> {
    const before = gateway.sent.length;
    await receive(body, options);
    return nextReply(before + 1);
  }

  // ---- alur utama ----

  describe('alur utama', () => {
    it('pesan masuk -> konfirmasi -> ya -> transaksi tersimpan', async () => {
      const sourceId = await receive('tadi makan siang 25 ribu');
      const confirmation = await nextReply(1);

      // Konfirmasi berbasis teks: nominal, kategori, tanggal, kutipan, dan instruksi.
      expect(confirmation).toContain('🍔');
      expect(confirmation).toContain('Pengeluaran · Makanan');
      expect(confirmation).toContain('Rp25.000');
      expect(confirmation).toContain('Hari ini');
      expect(confirmation).toMatch(/YA.*BATAL/);
      expect(gateway.sent[0]?.to).toBe(PHONE_CHAT);
      // Belum ada yang tersimpan sebelum "ya", dan pending ada di Redis dengan TTL 15 menit.
      expect(await transactions()).toHaveLength(0);
      const ttl = await redis.ttl(pendingKey(userId));
      expect(ttl).toBeGreaterThan(14 * 60);
      expect(ttl).toBeLessThanOrEqual(15 * 60);

      const saved = await say('ya');
      expect(saved).toContain('Tersimpan');
      expect(saved).toContain('Rp25.000');

      const rows = await transactions();
      expect(rows).toHaveLength(1);
      const [tx] = rows;
      expect(tx).toMatchObject({
        userId,
        type: 'expense',
        amount: 25000,
        source: 'whatsapp',
        sourceMessageId: sourceId, // pesan yang memuat nominal, bukan "ya"
        description: 'makan siang',
        deletedAt: null,
      });
      expect(tx?.category.slug).toBe('food');
      expect(tx?.date.toISOString().slice(0, 10)).toBe(toJakartaDate(new Date()));
      expect(await redis.get(pendingKey(userId))).toBeNull();

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: tx!.id } });
      expect(audit).toMatchObject({ action: 'create', actorType: 'whatsapp', userId });
    });

    it('pesan masuk -> konfirmasi -> batal -> tidak ada transaksi', async () => {
      await say('tadi makan siang 25 ribu');
      expect(await redis.get(pendingKey(userId))).not.toBeNull();

      const reply = await say('batal');

      expect(reply).toMatch(/dibatalkan/i);
      expect(await transactions()).toHaveLength(0);
      expect(await redis.get(pendingKey(userId))).toBeNull();
      // "ya" sesudahnya tidak menyimpan apa pun: pending sudah tidak ada.
      expect(await say('ya')).toMatch(/Tidak ada transaksi yang menunggu/);
      expect(await transactions()).toHaveLength(0);
    });

    it('pesan dicatat di message_logs: user, intent, parse_result, dan status processed', async () => {
      const id = await receive('tadi makan siang 25 ribu');
      await nextReply(1);
      await waitFor(async () => (await messageStatus(id)) === 'processed', 5000, 'pesan processed');

      const row = await prisma.messageLog.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ userId, intent: 'CREATE_TRANSACTION', status: 'processed', error: null });
      expect(row.processedAt).not.toBeNull();
      expect(row.parseResult).toMatchObject({ outcome: 'ready', amount: 25000, categorySlug: 'food' });
      const account = await prisma.whatsappAccount.findFirstOrThrow({ where: { userId } });
      expect(account.lastMessageAt).not.toBeNull();
    });

    it('"kemarin" menyimpan tanggal kemarin; nominal dan tanggal hanya dari regex', async () => {
      await say('kemarin beli bensin 50rb');
      expect(await say('y')).toContain('Tersimpan');

      const [tx] = await transactions();
      expect(tx?.amount).toBe(50000);
      expect(tx?.category.slug).toBe('transport');
      const yesterday = toJakartaDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
      expect(tx?.date.toISOString().slice(0, 10)).toBe(yesterday);
    });

    it('pemasukan: "gaji 5 juta" disimpan sebagai income', async () => {
      const confirmation = await say('gaji bulan ini 5 juta');
      expect(confirmation).toContain('Pemasukan · Gaji');
      expect(confirmation).toContain('Rp5.000.000');
      await say('ok');

      const [tx] = await transactions();
      expect(tx).toMatchObject({ type: 'income', amount: 5_000_000 });
      expect(tx?.category.slug).toBe('salary');
    });

    it('angka telanjang pengeluaran dibaca ribuan dan asumsinya tampak di konfirmasi', async () => {
      const confirmation = await say('beli makan 20');
      expect(confirmation).toContain('Rp20.000');
      expect(confirmation).toMatch(/ribuan/);
    });
  });

  // ---- klarifikasi ----

  describe('klarifikasi', () => {
    it('kategori kabur: tiga kategori bernomor, dijawab dengan angka', async () => {
      const question = await say('keluar 50 ribu');

      expect(question).toContain('Rp50.000');
      const options = [...question.matchAll(/^(\d)\. (.+)$/gm)].map((match) => match[2]!);
      expect(options).toHaveLength(3);
      expect(question.split('\n').length).toBeLessThanOrEqual(5);

      const confirmation = await say('2');
      expect(confirmation).toContain(options[1]);
      expect(confirmation).toContain('Rp50.000');

      await say('ya');
      const [tx] = await transactions();
      expect(tx).toMatchObject({ amount: 50000, type: 'expense' });
      expect(tx?.category.name).toBe(options[1]);
    });

    it('kategori kabur: dijawab dengan nama, huruf besar pun diterima', async () => {
      await say('keluar 50 ribu');
      const confirmation = await say('Transportasi');

      expect(confirmation).toContain('Pengeluaran · Transportasi');
      await say('ya');
      expect((await transactions())[0]?.category.slug).toBe('transport');
    });

    it('jawaban kategori yang tidak dikenal: ditanya ulang dengan singkat, pending tetap, bisa dijawab benar', async () => {
      await say('keluar 50 ribu');
      const again = await say('zzzz');

      expect(again).toMatch(/BATAL/);
      expect(again.split('\n').length).toBeLessThanOrEqual(5);
      expect(await redis.get(pendingKey(userId))).not.toBeNull();
      expect(await say('9')).toMatch(/^Belum ketemu/); // nomor di luar pilihan

      expect(await say('1')).toContain('Rp50.000');
    });

    it('"ya" saat masih ditanya kategori tidak menyimpan apa pun', async () => {
      await say('keluar 50 ribu');
      const reply = await say('ya');

      expect(reply).toMatch(/Pilih kategorinya dulu/);
      expect(await transactions()).toHaveLength(0);
    });

    it('nominal tidak ada: hanya nominal yang ditanyakan, kategori terdeteksi disebut', async () => {
      const question = await say('bayar listrik');

      expect(question).toBe('"bayar listrik" masuk Tagihan.\nBerapa nominalnya?');

      const confirmation = await say('350rb');
      expect(confirmation).toContain('Pengeluaran · Tagihan');
      expect(confirmation).toContain('Rp350.000');
      await say('ya');
      expect((await transactions())[0]).toMatchObject({ amount: 350000, description: 'bayar listrik' });
    });

    it('nominal dan kategori sama-sama kurang: nominal dulu, lalu kategori, lalu konfirmasi', async () => {
      // Command tanpa argumen: tidak ada nominal dan tidak ada kategori.
      expect(await say('/keluar')).toMatch(/Berapa nominalnya/);
      const askCategory = await say('75 ribu');
      expect(askCategory).toContain('Rp75.000');
      expect(askCategory).toMatch(/^1\. /m);
      const confirmation = await say('1');
      expect(confirmation).toContain('Rp75.000');
      expect(confirmation).toMatch(/YA.*BATAL/);
    });

    it('pemasukan "gaji 5": tidak ditebak, ditanya 5 ribu atau 5 juta', async () => {
      const question = await say('gaji 5');
      expect(question).toMatch(/5 ribu atau 5 juta/);
      expect(await transactions()).toHaveLength(0);

      const confirmation = await say('5 juta');
      expect(confirmation).toContain('Rp5.000.000');
      expect(confirmation).toContain('Pemasukan · Gaji');
    });

    it('jawaban nominal yang tidak terbaca ditanya ulang; BATAL keluar dari pertanyaan', async () => {
      await say('/keluar');
      expect(await say('banyak')).toMatch(/belum terbaca/i);
      expect(await say('batal')).toMatch(/dibatalkan/i);
      expect(await redis.get(pendingKey(userId))).toBeNull();
    });

    it('pesan tak dikenal saat ada konfirmasi menunggu: pengingat singkat, pending tetap', async () => {
      await say('makan siang 25 ribu');
      expect(await say('hmm gimana ya')).toMatch(/Masih ada transaksi yang menunggu/);
      expect(await redis.get(pendingKey(userId))).not.toBeNull();
      await say('ya');
      expect(await transactions()).toHaveLength(1);
    });

    it('pending baru menimpa yang lama secara diam-diam', async () => {
      await say('makan siang 25 ribu');
      const second = await say('beli bensin 50 ribu');
      expect(second).toContain('Transportasi');

      await say('ya');
      const rows = await transactions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 50000 });
    });

    it('pesan yang ditolak (nominal nol) dijelaskan dan tidak menyentuh pending yang ada', async () => {
      await say('makan siang 25 ribu');
      const rejection = await say('makan 0');

      expect(rejection).toMatch(/nol/);
      expect(await redis.get(pendingKey(userId))).not.toBeNull();
      await say('ya');
      expect((await transactions())[0]?.amount).toBe(25000);
    });
  });

  // ---- tanpa pending, kedaluwarsa, intent lain ----

  describe('tanpa pending dan intent lain', () => {
    it('"ya" tanpa pending: dijelaskan, tidak ada transaksi', async () => {
      const reply = await say('ya');
      expect(reply).toMatch(/Tidak ada transaksi yang menunggu konfirmasi/);
      expect(await transactions()).toHaveLength(0);
    });

    it('pending kedaluwarsa (TTL habis): "ya" tidak menyimpan apa pun dan tidak ada pengingat sebelumnya', async () => {
      await say('makan siang 25 ribu');
      await redis.expire(pendingKey(userId), 1);
      await sleep(1300);
      const sentBefore = gateway.sent.length;

      const reply = await say('ya');

      expect(reply).toMatch(/Tidak ada transaksi yang menunggu/);
      expect(reply).toMatch(/15 menit/);
      expect(await transactions()).toHaveLength(0);
      expect(sentBefore).toBe(1); // satu-satunya pesan sebelum "ya" adalah konfirmasi; tidak ada pengingat
    });

    it('HELP dan UNKNOWN dibalas contoh pemakaian; QUERY dan CORRECT dibalas belum tersedia', async () => {
      expect(await say('bantuan')).toMatch(/Contoh yang bisa dicatat/);
      expect(await say('halo apa kabar')).toMatch(/Belum paham/);
      expect(await say('saldo berapa?')).toMatch(/belum tersedia/);
      expect(await say('ubah jadi 35 ribu')).toMatch(/belum bisa/);
      expect(await transactions()).toHaveLength(0);
    });

    it('pesan kosong tidak dibalas', async () => {
      const id = await receive('   ');
      await waitFor(async () => (await messageStatus(id)) === 'processed', 5000, 'pesan kosong diproses');
      await sleep(200);
      expect(gateway.sent).toHaveLength(0);
    });

    it('hapus transaksi terakhir: konfirmasi lalu soft delete oleh aktor whatsapp', async () => {
      await say('makan siang 25 ribu');
      await say('ya');
      const [tx] = await transactions();

      const confirm = await say('hapus transaksi terakhir');
      expect(confirm).toContain('Hapus transaksi ini?');
      expect(confirm).toContain('Rp25.000');
      expect((await transactions())[0]?.deletedAt).toBeNull(); // belum dihapus sebelum "ya"

      expect(await say('ya')).toContain('Dihapus');
      const after = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } });
      expect(after.deletedAt).not.toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: tx!.id, action: 'delete' } });
      expect(audit.actorType).toBe('whatsapp');
    });

    it('hapus transaksi terakhir: dibatalkan dengan "batal", transaksi tetap', async () => {
      await say('makan siang 25 ribu');
      await say('ya');
      await say('hapus transaksi terakhir');
      expect(await say('batal')).toMatch(/dibatalkan/i);
      expect((await transactions())[0]?.deletedAt).toBeNull();
    });

    it('hapus tanpa transaksi WhatsApp: dijelaskan', async () => {
      expect(await say('hapus transaksi terakhir')).toMatch(/Tidak ada transaksi dari WhatsApp/);
    });
  });

  // ---- pengirim dan jenis pesan ----

  describe('pengirim dan jenis pesan', () => {
    it('nomor belum terdaftar: ajakan daftar MAKSIMAL SATU KALI per nomor per 24 jam, pesan ditandai ignored', async () => {
      const first = await receive('makan siang 25 ribu', { from: STRANGER_CHAT });
      await nextReply(1);
      const second = await receive('halo?', { from: STRANGER_CHAT });
      const third = await receive('tolong dong', { from: STRANGER_CHAT });
      await waitFor(
        async () => (await Promise.all([first, second, third].map(messageStatus))).every((s) => s === 'ignored'),
        5000,
        'ketiga pesan ignored',
      );
      await sleep(200);

      expect(gateway.sent).toHaveLength(1);
      expect(gateway.sent[0]).toMatchObject({ to: STRANGER_CHAT });
      expect(gateway.sent[0]?.body).toMatch(/belum terhubung/);
      expect(await redis.ttl(inviteKey(STRANGER_CHAT))).toBeGreaterThan(23 * 60 * 60);
      // Tidak ada transaksi, dan baris pesan tidak dikaitkan ke pengguna mana pun.
      expect(await transactions()).toHaveLength(0);
      const row = await prisma.messageLog.findUniqueOrThrow({ where: { id: first } });
      expect(row).toMatchObject({ userId: null, status: 'ignored' });
    });

    it('nomor tak dikenal lain mendapat ajakannya sendiri', async () => {
      await receive('halo', { from: STRANGER_CHAT });
      await nextReply(1);
      await receive('halo', { from: OTHER_STRANGER_CHAT });
      await nextReply(2);
      expect(gateway.sent.map((m) => m.to).sort()).toEqual([STRANGER_CHAT, OTHER_STRANGER_CHAT].sort());
    });

    it('nomor yang tautannya belum diverifikasi diperlakukan sebagai tidak dikenal', async () => {
      await prisma.whatsappAccount.updateMany({ where: { userId }, data: { status: 'pending' } });
      await receive('makan siang 25 ribu');
      expect(await nextReply(1)).toMatch(/belum terhubung/);
      expect(await redis.get(pendingKey(userId))).toBeNull();
    });

    it('media dibalas "belum didukung", dicatat ignored, dan tidak membuat pending', async () => {
      const id = await receive('/9j/4AAQSkZJRgABAQAAAQABAAD', { type: 'image' });
      const reply = await nextReply(1);

      expect(reply).toMatch(/belum bisa dibaca/);
      await waitFor(async () => (await messageStatus(id)) === 'ignored', 5000, 'media ignored');
      const row = await prisma.messageLog.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ userId, intent: 'UNSUPPORTED_MEDIA' });
      expect(await redis.get(pendingKey(userId))).toBeNull();
      expect(await transactions()).toHaveLength(0);
    });

    it('jenis pesan sistem (bukan teks maupun media) tidak dibalas', async () => {
      const id = await receive('', { type: 'e2e_notification' });
      await waitFor(async () => (await messageStatus(id)) === 'ignored', 5000, 'pesan sistem ignored');
      await sleep(200);
      expect(gateway.sent).toHaveLength(0);
    });
  });

  // ---- urutan dan idempotensi ----

  describe('urutan menurut timestamp dan idempotensi', () => {
    it('"ya" yang tiba LEBIH DULU dari pesan transaksinya tetap diproses sesudahnya (urut timestamp, bukan kedatangan)', async () => {
      const t = baseTimestamp + 100;
      // Keduanya sudah ada di database; "ya" (timestamp lebih baru) diantrekan lebih dulu.
      const transaction = await store('makan siang 25 ribu', { timestamp: t });
      const yes = await store('ya', { timestamp: t + 1 });
      await enqueue(yes);
      await enqueue(transaction);

      await nextReply(2);
      await waitFor(async () => (await transactions()).length === 1, 5000, 'transaksi tersimpan');
      await sleep(300); // job kedua tidak boleh memproses ulang

      expect(gateway.sent).toHaveLength(2);
      expect(gateway.sent[0]?.body).toMatch(/Balas YA untuk simpan/); // konfirmasi lebih dulu
      expect(gateway.sent[1]?.body).toMatch(/Tersimpan/);
      const rows = await transactions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 25000, sourceMessageId: transaction });
      expect(await messageStatus(transaction)).toBe('processed');
      expect(await messageStatus(yes)).toBe('processed');
    });

    it('pesan tiba berurutan tetapi timestamp terbalik: yang lebih lama menang meski diantrekan belakangan', async () => {
      const t = baseTimestamp + 200;
      const newer = await store('beli bensin 50 ribu', { timestamp: t + 5 });
      const older = await store('makan siang 25 ribu', { timestamp: t });
      await enqueue(newer);
      await enqueue(older);

      await nextReply(2);
      // Yang lebih lama diproses lebih dulu, jadi pending akhirnya milik yang lebih baru.
      expect(gateway.sent[0]?.body).toContain('Makanan');
      expect(gateway.sent[1]?.body).toContain('Transportasi');
      await say('ya');
      expect((await transactions())[0]?.amount).toBe(50000);
    });

    it('job diulang setelah transaksi tersimpan: tidak ada transaksi ganda dan tidak ada balasan ganda', async () => {
      await say('makan siang 25 ribu');
      const yes = await receive('ya');
      await nextReply(2);
      expect(await transactions()).toHaveLength(1);

      // Meniru crash sesudah transaksi tersimpan tetapi sebelum pesan ditutup dan pending dihapus.
      const sourceId = (await transactions())[0]!.sourceMessageId!;
      await prisma.messageLog.update({ where: { id: yes }, data: { status: 'received', processedAt: null } });
      await redis.set(
        pendingKey(userId),
        JSON.stringify({
          kind: 'confirmation',
          draft: {
            type: 'expense',
            amount: 25000,
            categorySlug: 'food',
            date: toJakartaDate(new Date()),
            description: 'makan siang',
            assumedThousands: false,
            sourceMessageId: sourceId,
          },
        }),
        'EX',
        60,
      );

      await pipeline.processor({ message_log_id: yes }, {} as never);
      await sleep(300);

      expect(await transactions()).toHaveLength(1); // dijaga findBySourceMessage
      expect(gateway.sent).toHaveLength(2); // balasan dijaga jobId `reply-<id>`
      expect(await redis.get(pendingKey(userId))).toBeNull();
      expect(await messageStatus(yes)).toBe('processed');
    });

    it('job untuk pesan yang sudah diproses tidak berbuat apa-apa', async () => {
      const id = await receive('makan siang 25 ribu');
      await nextReply(1);
      await waitFor(async () => (await messageStatus(id)) === 'processed', 5000, 'processed');

      await pipeline.processor({ message_log_id: id }, {} as never);
      await sleep(200);

      expect(gateway.sent).toHaveLength(1);
    });

    it('pesan yang barisnya hilang dilewati tanpa galat', async () => {
      await expect(pipeline.processor({ message_log_id: randomUUID() }, {} as never)).resolves.toBeUndefined();
    });

    it('pengguna berbeda tidak saling melihat pending: konfirmasi A tidak menyimpan transaksi B', async () => {
      const otherId = await createUser2();
      await say('makan siang 25 ribu');
      // Pengguna lain berbicara dari nomornya sendiri dan menjawab "ya".
      const reply = await say('ya', { from: '628555555555@c.us' });
      expect(reply).toMatch(/Tidak ada transaksi yang menunggu/);
      expect(await transactions()).toHaveLength(0);
      expect(await prisma.transaction.count({ where: { userId: otherId } })).toBe(0);
      await redis.del(pendingKey(otherId));
    });

    async function createUser2(): Promise<string> {
      const provider = new FakeAuthProvider(prisma);
      const { identity } = await provider.signUp({
        email: `lain-${randomUUID()}@example.com`,
        password: 'rahasia-banget-123',
        fullName: 'Pengguna Lain',
      });
      await createAuthRepository(prisma).provisionNewUser({
        id: identity.id,
        fullName: 'Pengguna Lain',
        avatarUrl: null,
        initialBalance: 0,
      });
      await prisma.whatsappAccount.create({
        data: {
          userId: identity.id,
          phoneE164: '+628555555555',
          waChatId: '628555555555@c.us',
          status: 'verified',
          verifiedAt: new Date(),
        },
      });
      return identity.id;
    }
  });

  // ---- outbound ----

  describe('outbound', () => {
    it('sesi terputus: balasan ditunda, bukan digugurkan, dan terkirim begitu sesi pulih', async () => {
      gateway.setConnected(false);
      await receive('makan siang 25 ribu');

      // Tidak ada yang terkirim selama terputus; job menunggu di antrean tertunda, tidak gagal.
      await waitFor(
        async () => (await queues.outbound.getDelayedCount()) + (await queues.outbound.getWaitingCount()) >= 1,
        5000,
        'balasan masuk antrean outbound',
      );
      await sleep(500);
      expect(gateway.sent).toHaveLength(0);
      expect(await queues.outbound.getFailedCount()).toBe(0);

      gateway.setConnected(true);
      expect(await nextReply(1)).toContain('Rp25.000');
      expect(await queues.outbound.getFailedCount()).toBe(0);
    });

    it('menunda tidak memakai jatah percobaan: tiga kali tunda, lalu masih bisa terkirim', async () => {
      gateway.setConnected(false);
      await receive('makan siang 25 ribu');
      await sleep(600); // beberapa putaran tunda (jeda 100 ms)
      gateway.setConnected(true);

      await nextReply(1);
      const [job] = await queues.outbound.getJobs(['completed']);
      expect(job?.attemptsMade).toBeLessThanOrEqual(1);
    });

    it('gagal kirim tiga kali: dicatat reply_failed pada pesan pemicunya, dan transaksi tidak terpengaruh', async () => {
      const id = await store('makan siang 25 ribu');
      await prisma.messageLog.update({ where: { id }, data: { status: 'processed' } });
      gateway.sendText = async () => {
        throw new Error('OpenWA mati');
      };

      await queues.outbound.add(
        'send-message',
        { wa_chat_id: PHONE_CHAT, text: 'halo', message_log_id: id },
        { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
      );

      await waitFor(
        async () => (await prisma.messageLog.findUniqueOrThrow({ where: { id } })).error === 'reply_failed',
        8000,
        'reply_failed tercatat',
      );
      const [failed] = await queues.outbound.getFailed();
      expect(failed?.attemptsMade).toBe(3);
      expect(await messageStatus(id)).toBe('processed'); // status pesan tidak berubah
    });

    it('balasan yang sudah terlalu lama di antrean digugurkan, bukan dikirim', async () => {
      const id = await store('x');
      await queues.outbound.add(
        'send-message',
        { wa_chat_id: PHONE_CHAT, text: 'basi', message_log_id: id },
        { timestamp: Date.now() - 2 * 60 * 60 * 1000 },
      );

      await waitFor(async () => (await queues.outbound.getFailedCount()) === 1, 5000, 'job digugurkan');
      expect(gateway.sent).toHaveLength(0);
      // Dicatat oleh listener 'failed', yang berjalan sesudah job pindah ke daftar gagal.
      await waitFor(
        async () => (await prisma.messageLog.findUniqueOrThrow({ where: { id } })).error === 'reply_failed',
        5000,
        'reply_failed tercatat',
      );
    });
  });

  describe('job inbound gagal', () => {
    it('setelah percobaan terakhir pesan ditandai failed (tidak menggantung di received)', async () => {
      const id = await store('makan siang 25 ribu');

      await pipeline.markInboundFailed({ message_log_id: id }, new Error('Redis tidak dapat dihubungi'));

      const row = await prisma.messageLog.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'failed', error: 'Redis tidak dapat dihubungi' });
    });

    it('pesan yang sudah ditutup tidak ditimpa menjadi failed', async () => {
      const id = await receive('makan siang 25 ribu');
      await nextReply(1);
      await waitFor(async () => (await messageStatus(id)) === 'processed', 5000, 'processed');

      await pipeline.markInboundFailed({ message_log_id: id }, new Error('terlambat'));

      expect(await messageStatus(id)).toBe('processed');
    });
  });
});
