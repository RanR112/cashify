// Pemroses pesan masuk (ARCHITECTURE.md Bagian 13, "Fase asinkron"). Dipasang ke worker `inbound`
// oleh src/worker.ts; dipisah dari inbound.worker.ts supaya urusan BullMQ (job, retry, penutupan)
// tidak bercampur dengan urusan WhatsApp.
//
// Urutan kerja satu job:
//   1. muat pesan dari database (hanya id yang dikirim lewat antrean)
//   2. kenali pengguna lewat nomor pengirim, tautan `verified` saja
//        tidak dikenal -> ajakan daftar, MAKS. SATU KALI PER NOMOR PER 24 JAM; pesan ditandai ignored
//   3. ambil lock pengguna (lib/userLock.ts), lalu di dalamnya:
//   4. kuras pesan se-chat yang LEBIH LAMA menurut timestamp WhatsApp tetapi tiba lebih lambat, lalu
//      proses pesan ini. Urutan webhook tidak dijamin; urutan waktu pesan yang menentukan.
//   5. jenis pesan: media dibalas "belum didukung"; teks diserahkan ke percakapan
//
// Catatan urutan: spesifikasi menyebut lock sebelum pencarian pengguna, tetapi kunci lock memuat
// `user_id`, jadi pengguna harus dikenali lebih dulu (pencarian itu hanya membaca). Pesan dari nomor
// tak dikenal tidak butuh lock: tidak ada state yang diurutkan.
//
// Batasan yang diketahui: pesan lebih lama yang BELUM sampai ke database saat pesan baru diproses
// tidak ditunggu. Menunggunya berarti menahan semua pesan pengguna demi kemungkinan yang jarang.
//
// Idempotensi: `closeMessage` hanya menutup baris yang masih `received`, dan pesan yang sudah
// ditutup dilewati. Job yang diulang setelah sebagian efek terjadi aman: transaksi dijaga
// `findBySourceMessage`, balasan dijaga `jobId` antrean (`reply-<message_log_id>`).

import type { Redis } from 'ioredis';
import { logger } from '../config/logger.js';
import { withUserLock, type WithUserLockOptions } from '../lib/userLock.js';
import type { Conversation } from '../modules/whatsapp/whatsapp.conversation.js';
import * as templates from '../modules/whatsapp/whatsapp.templates.js';
import type {
  InboundMessageRecord,
  ReplyRequest,
  WhatsappAccountRecord,
  WhatsappRepository,
} from '../modules/whatsapp/whatsapp.types.js';
import { maskPhoneForLog } from '../shared/utils/phone.js';
import type { InboundProcessor } from './inbound.worker.js';

/** Ajakan daftar: satu per nomor per 24 jam, supaya nomor iseng tidak membuat bot membanjiri chat (Bagian 13). */
export const INVITE_TTL_SECONDS = 24 * 60 * 60;
export const inviteKey = (chatId: string): string => `invite:${chatId}`;

/** Seberapa jauh ke belakang (menurut waktu masuk database) pesan tertunda dicari untuk dikuras lebih dulu. */
export const BACKLOG_WINDOW_MS = 10 * 60 * 1000;
export const BACKLOG_LIMIT = 20;

/** Jenis OpenWA yang dijawab "belum didukung". Jenis sistem lain (notifikasi enkripsi, dsb.) tidak dijawab. */
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'ptt',
  'audio',
  'document',
  'sticker',
  'location',
  'vcard',
  'multi_vcard',
]);
const TEXT_TYPE = 'chat';

export interface InboundProcessorDeps {
  /** Klien helper (gagal cepat), bukan koneksi BullMQ. Dipakai untuk lock pengguna dan batas ajakan daftar. */
  redis: Redis;
  repository: Pick<
    WhatsappRepository,
    'findInboundMessage' | 'findVerifiedAccountByChat' | 'findReceivedInChat' | 'closeMessage' | 'touchLastMessage'
  >;
  conversation: Pick<Conversation, 'handle'>;
  /** Memasukkan balasan ke antrean `outbound`; tidak pernah memanggil gateway (aturan 10). */
  reply: (request: ReplyRequest) => Promise<unknown>;
  lock?: WithUserLockOptions;
  /** Penyuntik jam untuk test. */
  now?: () => Date;
}

/** Urutan waktu pesan; seri dipecahkan waktu masuk database, lalu id, supaya urutannya selalu sama. */
export function compareMessages(a: InboundMessageRecord, b: InboundMessageRecord): number {
  return (
    a.sentAt.getTime() - b.sentAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

export function createInboundProcessor(deps: InboundProcessorDeps): InboundProcessor {
  const { redis, repository, conversation } = deps;
  const clock = deps.now ?? (() => new Date());

  /** Nomor tak dikenal: ajakan daftar paling banyak sekali per 24 jam, lalu pesan ditandai ignored. */
  async function handleStranger(message: InboundMessageRecord): Promise<void> {
    // Balasan ke nomor (`@c.us`) bila ada: itu bentuk yang dipakai OTP. LID hanya cadangan.
    const replyTo = message.senderChatId ?? message.waChatId;
    const replyable = message.messageType === TEXT_TYPE || MEDIA_TYPES.has(message.messageType);

    let invited = false;
    if (replyable) {
      invited = (await redis.set(inviteKey(replyTo), '1', 'EX', INVITE_TTL_SECONDS, 'NX')) === 'OK';
      if (invited) await deps.reply({ to: replyTo, text: templates.inviteToRegister(), messageLogId: message.id });
    }
    await repository.closeMessage(
      message.id,
      { status: 'ignored', parseResult: { reason: 'unregistered_sender', invited } },
      clock(),
    );
    logger.info({ messageLogId: message.id, from: maskPhoneForLog(replyTo), invited }, 'Pesan dari nomor belum terdaftar');
  }

  /** Satu pesan milik pengguna yang dikenal. Dipanggil di dalam lock. */
  async function processOne(account: WhatsappAccountRecord, message: InboundMessageRecord): Promise<void> {
    const userId = account.userId;
    const replyTo = account.waChatId;

    if (message.messageType !== TEXT_TYPE) {
      const media = MEDIA_TYPES.has(message.messageType);
      if (media) await deps.reply({ to: replyTo, text: templates.unsupportedMedia(), messageLogId: message.id });
      await repository.closeMessage(
        message.id,
        {
          status: 'ignored',
          userId,
          intent: media ? 'UNSUPPORTED_MEDIA' : 'IGNORED',
          parseResult: { reason: media ? 'unsupported_type' : 'system_type', type: message.messageType },
        },
        clock(),
      );
      return;
    }

    const outcome = await conversation.handle({
      userId,
      messageId: message.id,
      text: message.body ?? '',
      sentAt: message.sentAt,
      replyTo,
    });
    await repository.closeMessage(
      message.id,
      { status: 'processed', userId, intent: outcome.intent, parseResult: outcome.parseResult },
      clock(),
    );
    await repository.touchLastMessage(userId, message.sentAt);
  }

  /** Di dalam lock: pesan lebih lama yang tiba belakangan diproses lebih dulu, lalu pesan ini. */
  async function processInOrder(account: WhatsappAccountRecord, message: InboundMessageRecord): Promise<void> {
    // Selama menunggu lock, pesan ini mungkin sudah dikuras oleh job lain.
    const fresh = await repository.findInboundMessage(message.id);
    if (fresh?.status !== 'received') return;

    const since = new Date(clock().getTime() - BACKLOG_WINDOW_MS);
    const waiting = await repository.findReceivedInChat(message.sessionId, message.waChatId, since, message.id, BACKLOG_LIMIT);
    const earlier = waiting.filter((other) => compareMessages(other, message) < 0).sort(compareMessages);

    for (const next of [...earlier, message]) await processOne(account, next);
  }

  return async (data) => {
    const message = await repository.findInboundMessage(data.message_log_id);
    if (!message) {
      // Data tidak konsisten (baris hilang); mengulang tidak akan membantu.
      logger.warn({ messageLogId: data.message_log_id }, 'Pesan masuk tidak ditemukan, job dilewati');
      return;
    }
    if (message.status !== 'received') return; // sudah diproses (job diulang, atau sudah dikuras lebih dulu)

    const chatIds = [...new Set([message.senderChatId, message.waChatId].filter((id): id is string => !!id))];
    const account = await repository.findVerifiedAccountByChat(chatIds);
    if (!account) return handleStranger(message);

    await withUserLock(redis, account.userId, () => processInOrder(account, message), deps.lock);
  };
}
