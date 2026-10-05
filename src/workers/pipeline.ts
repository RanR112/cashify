// Merakit pemroses pesan masuk dengan implementasi aslinya: repository dan service dari modul,
// Redis untuk state percakapan dan lock. Ini composition root worker, seperti app.ts untuk API:
// satu-satunya tempat modul whatsapp dipertemukan dengan modul transactions, categories, dan
// accounts (modul sendiri tidak saling mengimpor, jadi mereka dihubungkan lewat port).
//
// Dipakai src/worker.ts dan test integrasi, supaya yang diuji persis yang berjalan.

import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { logger } from '../config/logger.js';
import { createPendingStore } from '../lib/pendingState.js';
import type { WithUserLockOptions } from '../lib/userLock.js';
import { createAccountsRepository } from '../modules/accounts/accounts.repository.js';
import { createCategoriesRepository } from '../modules/categories/categories.repository.js';
import { mergeCategories } from '../modules/categories/categories.service.js';
import { createTransactionsRepository } from '../modules/transactions/transactions.repository.js';
import { createTransactionsService } from '../modules/transactions/transactions.service.js';
import { createConversation, pendingSchema } from '../modules/whatsapp/whatsapp.conversation.js';
import { createWhatsappRepository } from '../modules/whatsapp/whatsapp.repository.js';
import type { ConversationPorts, ReplyRequest } from '../modules/whatsapp/whatsapp.types.js';
import { isAppError } from '../shared/errors/AppError.js';
import type { InboundJobData } from '../queues/inbound.queue.js';
import type { OutboundJobData } from '../queues/outbound.queue.js';
import { createInboundProcessor } from './inbound.processor.js';
import type { InboundProcessor } from './inbound.worker.js';

export interface InboundPipelineDeps {
  prisma: PrismaClient;
  /** Klien helper (bukan koneksi BullMQ): state percakapan, lock pengguna, batas ajakan daftar. */
  redis: Redis;
  /** Memasukkan balasan ke antrean `outbound`. Pipeline tidak pernah memanggil gateway (aturan 10). */
  enqueueReply: (request: ReplyRequest) => Promise<unknown>;
  lock?: WithUserLockOptions;
  now?: () => Date;
}

export interface InboundPipeline {
  processor: InboundProcessor;
  /** Job inbound gagal untuk terakhir kalinya: tandai pesannya `failed`. */
  markInboundFailed(data: InboundJobData, error: Error): Promise<void>;
  /** Balasan gagal terkirim permanen: catat di pesan pemicunya. */
  recordReplyFailure(data: OutboundJobData, error: Error): Promise<void>;
}

export function createInboundPipeline(deps: InboundPipelineDeps): InboundPipeline {
  const { prisma, redis } = deps;
  const whatsappRepository = createWhatsappRepository(prisma);
  const transactions = createTransactionsService(createTransactionsRepository(prisma));
  const categories = createCategoriesRepository(prisma);
  const accounts = createAccountsRepository(prisma);

  const ports: ConversationPorts = {
    categories: {
      list: async (userId) =>
        // Salinan milik pengguna menang atas kategori sistem dengan slug yang sama (API.md bagian 3).
        mergeCategories(await categories.listWithKeywords(userId))
          .filter((category) => category.type === 'income' || category.type === 'expense')
          .map((category) => ({
            id: category.id,
            slug: category.slug,
            name: category.name,
            type: category.type as 'income' | 'expense',
            keywords: category.keywords,
          })),
    },
    accounts: {
      // Akun default dulu, lalu yang tertua (urutan dari repository).
      defaultAccountId: async (userId) => (await accounts.listByUser(userId))[0]?.id ?? null,
    },
    transactions: {
      createFromWhatsapp: (userId, input) => transactions.createFromWhatsapp(userId, input),
      findBySourceMessage: (userId, sourceMessageId) => transactions.findBySourceMessage(userId, sourceMessageId),
      latestFromWhatsapp: (userId, now) => transactions.latestFromWhatsapp(userId, now),
      topCategoryIds: (userId, type, sinceDate, limit) => transactions.topCategoryIds(userId, type, sinceDate, limit),
      remove: async (userId, transactionId) => {
        try {
          const record = await transactions.get(userId, transactionId);
          await transactions.remove(userId, transactionId, { ipAddress: null, actor: 'whatsapp' });
          return record;
        } catch (error) {
          if (isAppError(error) && error.code === 'NOT_FOUND') return null;
          throw error;
        }
      },
    },
  };

  const conversation = createConversation({
    ...ports,
    pending: createPendingStore(redis, pendingSchema),
    reply: deps.enqueueReply,
  });

  return {
    processor: createInboundProcessor({
      redis,
      repository: whatsappRepository,
      conversation,
      reply: deps.enqueueReply,
      ...(deps.lock && { lock: deps.lock }),
      ...(deps.now && { now: deps.now }),
    }),

    async markInboundFailed(data, error) {
      await whatsappRepository.closeMessage(
        data.message_log_id,
        { status: 'failed', error: error.message.slice(0, 500) },
        deps.now?.() ?? new Date(),
      );
    },

    async recordReplyFailure(data, error) {
      // Balasan tanpa pesan pemicu (mis. OTP) tidak punya baris untuk ditandai; log saja.
      logger.error({ err: error, messageLogId: data.message_log_id }, 'Balasan WhatsApp gagal terkirim permanen');
      if (data.message_log_id) await whatsappRepository.recordReplyFailure(data.message_log_id);
    },
  };
}
