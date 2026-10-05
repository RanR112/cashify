import { Prisma, type PrismaClient } from '@prisma/client';
import type { WebhooksRepository } from './webhooks.types.js';

/** Kode galat Prisma untuk pelanggaran unique constraint. */
const UNIQUE_VIOLATION = 'P2002';

export function createWebhooksRepository(prisma: PrismaClient): WebhooksRepository {
  return {
    // `message_logs` bukan data milik pengguna: `user_id` baru dikenali di worker lewat nomor pengirim.
    insertReceived: async (input) => {
      try {
        const row = await prisma.messageLog.create({
          data: {
            sessionId: input.sessionId,
            waMessageId: input.waMessageId,
            waChatId: input.waChatId,
            direction: 'inbound',
            // Kolom VarChar(20); tipe OpenWA yang dikenal semuanya lebih pendek.
            messageType: input.messageType.slice(0, 20),
            body: input.body,
            rawPayload: input.rawPayload as Prisma.InputJsonObject,
            status: 'received',
            correlationId: input.correlationId,
          },
          select: { id: true },
        });
        return row.id;
      } catch (error) {
        // Unique index (session_id, wa_message_id) adalah penjamin idempotency (aturan 5).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return null;
        throw error;
      }
    },

    markEnqueueFailed: async (id) => {
      await prisma.messageLog.update({ where: { id }, data: { status: 'failed', error: 'enqueue_failed' } });
    },
  };
}
