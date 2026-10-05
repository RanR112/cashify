import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireUserId } from '../../shared/utils/userScope.js';
import type {
  AccountStatus,
  CompleteResult,
  InboundMessageRecord,
  VerificationRecord,
  WhatsappAccountRecord,
  WhatsappRepository,
} from './whatsapp.types.js';

/** Kode galat Prisma untuk pelanggaran unique constraint (termasuk partial unique index). */
const UNIQUE_VIOLATION = 'P2002';

const ACTIVE_STATUSES: AccountStatus[] = ['pending', 'verified'];

const accountSelect = {
  id: true,
  userId: true,
  phoneE164: true,
  waChatId: true,
  status: true,
  verifiedAt: true,
  lastMessageAt: true,
  dailySummaryEnabled: true,
  budgetAlertEnabled: true,
} satisfies Prisma.WhatsappAccountSelect;

type AccountRow = Prisma.WhatsappAccountGetPayload<{ select: typeof accountSelect }>;

/** Kolom `status` bertipe string di Prisma; nilainya dijaga oleh kode ini. */
function toAccount(row: AccountRow): WhatsappAccountRecord {
  return { ...row, status: row.status as AccountStatus };
}

const inboundSelect = {
  id: true,
  sessionId: true,
  waChatId: true,
  messageType: true,
  body: true,
  status: true,
  createdAt: true,
  rawPayload: true,
} satisfies Prisma.MessageLogSelect;

type InboundRow = Prisma.MessageLogGetPayload<{ select: typeof inboundSelect }>;

// Hanya yang dipakai worker; sisa ~100 field `raw_payload` dibiarkan (LOCAL-MODE.md, "Webhook OpenWA v4").
const storedPayloadSchema = z.looseObject({
  data: z
    .looseObject({
      timestamp: z.number().optional(),
      t: z.number().optional(),
      sender: z.looseObject({ phoneNumber: z.string().optional() }).optional(),
    })
    .optional(),
});

function toInbound(row: InboundRow): InboundMessageRecord {
  const payload = storedPayloadSchema.safeParse(row.rawPayload);
  const data = payload.success ? payload.data.data : undefined;
  // Detik sejak epoch. Nilai yang tidak masuk akal (bukan angka positif) tidak dipercaya.
  const seconds = data?.timestamp ?? data?.t;
  return {
    id: row.id,
    sessionId: row.sessionId,
    waChatId: row.waChatId,
    senderChatId: data?.sender?.phoneNumber ?? null,
    messageType: row.messageType,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt,
    sentAt: seconds !== undefined && seconds > 0 ? new Date(seconds * 1000) : row.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/** Dilempar di dalam transaksi untuk membatalkannya; ditangkap di `completeVerification`. */
class RollbackSignal extends Error {}

export function createWhatsappRepository(prisma: PrismaClient): WhatsappRepository {
  const repository: WhatsappRepository = {
    async findActiveAccount(userId) {
      const row = await prisma.whatsappAccount.findFirst({
        where: { userId: requireUserId(userId), status: { in: ACTIVE_STATUSES } },
        select: accountSelect,
      });
      return row ? toAccount(row) : null;
    },

    // Bukan data milik pengguna: justru memeriksa apakah pengguna LAIN sudah memegang nomor ini.
    async isPhoneVerifiedByAnyone(phoneE164) {
      const count = await prisma.whatsappAccount.count({ where: { phoneE164, status: 'verified' } });
      return count > 0;
    },

    async upsertPendingAccount(userId, phoneE164, waChatId, now) {
      requireUserId(userId);
      try {
        return await prisma.$transaction(async (tx) => {
          // Kode lama milik pengguna ini tidak boleh tetap berlaku untuk nomor yang berbeda.
          await tx.whatsappVerification.updateMany({
            where: { userId, consumedAt: null },
            data: { consumedAt: now },
          });
          const existing = await tx.whatsappAccount.findFirst({
            where: { userId, status: 'pending' },
            select: { id: true },
          });
          const row = existing
            ? await tx.whatsappAccount.update({
                where: { id: existing.id },
                data: { phoneE164, waChatId },
                select: accountSelect,
              })
            : await tx.whatsappAccount.create({
                data: { userId, phoneE164, waChatId, status: 'pending' },
                select: accountSelect,
              });
          return toAccount(row);
        });
      } catch (error) {
        // Dua permintaan serentak membuat baris aktif ganda; unique index `user_id` aktif menolak yang kedua.
        // Mengulang sekali: kali ini baris pertama sudah terlihat dan dipakai ulang.
        if (!isUniqueViolation(error)) throw error;
        return repository.upsertPendingAccount(userId, phoneE164, waChatId, now);
      }
    },

    createVerification: (userId, input) =>
      prisma.whatsappVerification.create({ data: { userId: requireUserId(userId), ...input } }),

    findPendingVerification: (userId) =>
      prisma.whatsappVerification.findFirst({
        where: { userId: requireUserId(userId), consumedAt: null },
        orderBy: { createdAt: 'desc' },
      }) satisfies Promise<VerificationRecord | null>,

    findLatestVerification: (userId) =>
      prisma.whatsappVerification.findFirst({
        where: { userId: requireUserId(userId) },
        orderBy: { createdAt: 'desc' },
      }),

    async countVerificationsSince(scope, since) {
      const where: Prisma.WhatsappVerificationWhereInput = {
        createdAt: { gte: since },
        ...('phoneE164' in scope ? { phoneE164: scope.phoneE164 } : { userId: requireUserId(scope.userId) }),
      };
      const result = await prisma.whatsappVerification.aggregate({
        where,
        _count: { _all: true },
        _min: { createdAt: true },
      });
      return { count: result._count._all, oldest: result._min.createdAt };
    },

    // Satu pernyataan: dua tebakan serentak tidak bisa sama-sama lolos dari batas percobaan.
    async incrementAttempts(userId, verificationId, max) {
      requireUserId(userId);
      const rows = await prisma.$queryRaw<{ attempts: number }[]>`
        UPDATE whatsapp_verifications
           SET attempts = attempts + 1
         WHERE id = ${verificationId}::uuid
           AND user_id = ${userId}::uuid
           AND consumed_at IS NULL
           AND attempts < ${max}
        RETURNING attempts`;
      return rows[0]?.attempts ?? null;
    },

    async completeVerification(userId, verificationId, now): Promise<CompleteResult> {
      requireUserId(userId);
      try {
        const account = await prisma.$transaction(async (tx) => {
          // `consumed_at IS NULL` di WHERE: dua verify serentak dengan kode benar, hanya satu yang menang.
          const claimed = await tx.whatsappVerification.updateMany({
            where: { id: verificationId, userId, consumedAt: null },
            data: { consumedAt: now },
          });
          if (claimed.count === 0) throw new RollbackSignal('already_used');

          const pending = await tx.whatsappAccount.findFirst({
            where: { userId, status: 'pending' },
            select: { id: true },
          });
          if (!pending) throw new RollbackSignal('already_used');

          // Bila nomor sudah terverifikasi akun lain, partial unique index menolak di sini (P2002)
          // dan seluruh transaksi, termasuk consumed_at, dibatalkan.
          return tx.whatsappAccount.update({
            where: { id: pending.id },
            data: { status: 'verified', verifiedAt: now },
            select: accountSelect,
          });
        });
        return { outcome: 'verified', account: toAccount(account) };
      } catch (error) {
        if (error instanceof RollbackSignal) return { outcome: 'already_used' };
        if (isUniqueViolation(error)) return { outcome: 'phone_taken' };
        throw error;
      }
    },

    async disableAccount(userId) {
      const { count } = await prisma.whatsappAccount.updateMany({
        where: { userId: requireUserId(userId), status: { in: ACTIVE_STATUSES } },
        data: { status: 'disabled' },
      });
      return count > 0;
    },

    async updatePreferences(userId, patch) {
      const where = { userId: requireUserId(userId), status: 'verified' };
      const { count } = await prisma.whatsappAccount.updateMany({
        where,
        data: {
          ...(patch.daily_summary_enabled !== undefined && { dailySummaryEnabled: patch.daily_summary_enabled }),
          ...(patch.budget_alert_enabled !== undefined && { budgetAlertEnabled: patch.budget_alert_enabled }),
        },
      });
      if (count === 0) return null;
      const row = await prisma.whatsappAccount.findFirst({ where, select: accountSelect });
      return row ? toAccount(row) : null;
    },

    // Bukan pencarian data milik pengguna: justru mencari pemilik nomor pengirim. Unique index
    // parsial (wa_chat_id) WHERE status = 'verified' menjamin paling banyak satu baris per id.
    async findVerifiedAccountByChat(chatIds) {
      if (chatIds.length === 0) return null;
      const row = await prisma.whatsappAccount.findFirst({
        where: { waChatId: { in: chatIds }, status: 'verified' },
        select: accountSelect,
      });
      return row ? toAccount(row) : null;
    },

    async findInboundMessage(id) {
      const row = await prisma.messageLog.findFirst({
        where: { id, direction: 'inbound' },
        select: inboundSelect,
      });
      return row ? toInbound(row) : null;
    },

    async findReceivedInChat(sessionId, waChatId, since, excludeId, limit) {
      const rows = await prisma.messageLog.findMany({
        where: {
          sessionId,
          waChatId,
          direction: 'inbound',
          status: 'received',
          createdAt: { gte: since },
          id: { not: excludeId },
        },
        select: inboundSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      return rows.map(toInbound);
    },

    async closeMessage(id, outcome, now) {
      // `status: 'received'` di WHERE: hanya satu pemroses yang bisa menutup sebuah pesan.
      const { count } = await prisma.messageLog.updateMany({
        where: { id, status: 'received' },
        data: {
          status: outcome.status,
          processedAt: now,
          ...(outcome.userId !== undefined && { userId: requireUserId(outcome.userId) }),
          ...(outcome.intent !== undefined && { intent: outcome.intent.slice(0, 30) }),
          ...(outcome.parseResult !== undefined && { parseResult: outcome.parseResult as Prisma.InputJsonObject }),
          ...(outcome.error !== undefined && { error: outcome.error }),
        },
      });
      return count > 0;
    },

    async recordReplyFailure(messageId) {
      await prisma.messageLog.updateMany({ where: { id: messageId }, data: { error: 'reply_failed' } });
    },

    async touchLastMessage(userId, at) {
      await prisma.whatsappAccount.updateMany({
        where: { userId: requireUserId(userId), status: 'verified' },
        data: { lastMessageAt: at },
      });
    },

    async upsertSession(snapshot, now) {
      const status = snapshot.connected ? 'connected' : 'disconnected';
      await prisma.whatsappSession.upsert({
        where: { sessionId: snapshot.sessionId },
        create: {
          sessionId: snapshot.sessionId,
          status,
          lastConnectedAt: snapshot.connected ? now : null,
          lastError: snapshot.connected ? null : (snapshot.detail ?? null),
        },
        update: {
          status,
          ...(snapshot.connected && { lastConnectedAt: now }),
          lastError: snapshot.connected ? null : (snapshot.detail ?? null),
        },
      });
    },
  };
  return repository;
}
