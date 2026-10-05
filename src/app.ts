import type { PrismaClient } from '@prisma/client';
import express, { type RequestHandler } from 'express';
import { mountSwagger } from './config/swagger.js';
import { createEnvAuthProvider } from './lib/auth.js';
import { getPrisma } from './lib/database.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { rateLimit } from './middleware/rateLimiter.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService, type AuthService } from './modules/auth/auth.service.js';
import { createAccountsRepository } from './modules/accounts/accounts.repository.js';
import { createAccountsRouter } from './modules/accounts/accounts.routes.js';
import { createAccountsService } from './modules/accounts/accounts.service.js';
import { createCategoriesRepository } from './modules/categories/categories.repository.js';
import { createCategoriesRouter } from './modules/categories/categories.routes.js';
import { createCategoriesService } from './modules/categories/categories.service.js';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { createDashboardService } from './modules/dashboard/dashboard.service.js';
import { createTransactionsRepository } from './modules/transactions/transactions.repository.js';
import { createTransactionsRouter } from './modules/transactions/transactions.routes.js';
import { createTransactionsService } from './modules/transactions/transactions.service.js';
import { createTransactionsSummary } from './modules/transactions/transactions.summary.js';
import { createUsersRepository } from './modules/users/users.repository.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { createUsersService } from './modules/users/users.service.js';
import { createWebhooksRepository } from './modules/webhooks/webhooks.repository.js';
import { createWebhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { createWhatsappRepository } from './modules/whatsapp/whatsapp.repository.js';
import { createWhatsappRouter } from './modules/whatsapp/whatsapp.routes.js';
import { createWhatsappService } from './modules/whatsapp/whatsapp.service.js';
import { createSessionMonitor } from './modules/whatsapp/whatsapp.session.js';
import type { OutboundMessage } from './modules/whatsapp/whatsapp.types.js';
import { createGatewayFromEnv, type WhatsAppGateway } from './gateways/whatsapp/index.js';
import { enqueueInbound, enqueueOutbound, getQueues, type InboundJobData } from './queues/index.js';

/** Antrean inbound bersama (Redis). Dibuat saat dipakai pertama kali, jadi createApp() tidak butuh Redis. */
async function enqueueToSharedInbound(data: InboundJobData): Promise<unknown> {
  const { inbound } = await getQueues();
  return enqueueInbound(inbound, data);
}

/** Antrean outbound bersama; yang mengirim tetap worker (aturan 12), bukan proses API. */
async function enqueueToSharedOutbound(message: OutboundMessage): Promise<unknown> {
  const { outbound } = await getQueues();
  return enqueueOutbound(outbound, message);
}

/** Gateway asli dari env, dibangun saat dipakai pertama kali (alasan yang sama dengan readWebhookSecretFromEnv). */
function createLazyEnvGateway(): WhatsAppGateway {
  let real: Promise<WhatsAppGateway> | undefined;
  const get = (): Promise<WhatsAppGateway> =>
    (real ??= import('./config/env.js').then(({ env }) => createGatewayFromEnv(env)));
  return {
    sendText: async (to, body) => (await get()).sendText(to, body),
    getStatus: async () => (await get()).getStatus(),
  };
}

async function readSessionIdFromEnv(): Promise<string> {
  return (await import('./config/env.js')).env.OPENWA_SESSION_ID;
}

/** Dibaca saat dipakai: env.ts memanggil process.exit bila variabel hilang, jadi tidak boleh dimuat bersama app.ts. */
async function readWebhookSecretFromEnv(): Promise<string> {
  return (await import('./config/env.js')).env.WEBHOOK_SECRET;
}

export interface AppDeps {
  /** Klien Prisma untuk modul users, accounts, categories, transactions, dashboard, webhooks; bawaannya klien tunggal dari lib/database. */
  prisma?: PrismaClient;
  /** Rahasia webhook (segmen path); bawaannya WEBHOOK_SECRET dari env. */
  webhookSecret?: string;
  /** Memasukkan job inbound; bawaannya antrean BullMQ asli. Test menyuntik versi palsu atau antrean berawalan unik. */
  enqueueInbound?: (data: InboundJobData) => Promise<unknown>;
  /** Gateway WhatsApp untuk memeriksa status sesi bot; bawaannya OpenWA dari env. Test menyuntik mock. */
  gateway?: WhatsAppGateway;
  /** Nama sesi bot untuk whatsapp_sessions; bawaannya OPENWA_SESSION_ID dari env. */
  botSessionId?: string;
  /** Memasukkan pesan ke antrean outbound (OTP); bawaannya antrean BullMQ asli. */
  enqueueOutbound?: (message: OutboundMessage) => Promise<unknown>;
  /** Disuntik di test; bawaannya Supabase Auth + Prisma sungguhan. */
  authService?: AuthService;
  /** Pemeriksa Bearer token untuk rute terproteksi; bawaannya JWT Supabase asli. */
  verifyAuth?: RequestHandler;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();

  // Konstruktor PrismaClient tidak membuka koneksi, jadi createApp() tanpa .env tetap bisa dimuat.
  const prisma = deps.prisma ?? getPrisma();

  // Webhook OpenWA dipasang PALING AWAL, sebelum pembatas global dan express.json: body harus dibaca
  // mentah, dan 429 dari batas global dianggap gagal oleh OpenWA lalu dikirim ulang. Webhook punya
  // pembatas sendiri (rateLimit('webhook')).
  app.use(
    '/webhooks',
    createWebhooksRouter({
      repository: createWebhooksRepository(prisma),
      enqueue: deps.enqueueInbound ?? enqueueToSharedInbound,
      getSecret: deps.webhookSecret === undefined ? readWebhookSecretFromEnv : () => deps.webhookSecret as string,
    }),
  );

  app.use(rateLimit('global'));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  mountSwagger(app);

  // Composition root: satu-satunya tempat modul dirakit dengan implementasi aslinya.
  const authService =
    deps.authService ??
    createAuthService({ provider: createEnvAuthProvider(), repository: createAuthRepository(deps.prisma ?? getPrisma()) });
  app.use('/auth', createAuthRouter(authService, deps.verifyAuth));

  const usersService = createUsersService(createUsersRepository(prisma));
  const transactionsService = createTransactionsService(createTransactionsRepository(prisma));

  app.use('/me', createUsersRouter(usersService, deps.verifyAuth));
  app.use('/accounts', createAccountsRouter(createAccountsService(createAccountsRepository(prisma)), deps.verifyAuth));
  app.use(
    '/categories',
    createCategoriesRouter(createCategoriesService(createCategoriesRepository(prisma)), deps.verifyAuth),
  );
  app.use('/transactions', createTransactionsRouter(transactionsService, deps.verifyAuth));

  const whatsappRepository = createWhatsappRepository(prisma);
  app.use(
    '/whatsapp',
    createWhatsappRouter(
      createWhatsappService({
        repository: whatsappRepository,
        session: createSessionMonitor({
          gateway: deps.gateway ?? createLazyEnvGateway(),
          repository: whatsappRepository,
          sessionId: deps.botSessionId ?? readSessionIdFromEnv,
        }),
        enqueueOutbound: deps.enqueueOutbound ?? enqueueToSharedOutbound,
      }),
      deps.verifyAuth,
    ),
  );

  // Dashboard adalah agregator: dirakit dari service lain, tanpa repository sendiri.
  app.use(
    '/dashboard',
    createDashboardRouter(
      createDashboardService({
        users: usersService,
        transactions: transactionsService,
        summary: createTransactionsSummary(prisma),
      }),
      deps.verifyAuth,
    ),
  );

  // Route modul dipasang di atas garis ini. notFound dan errorHandler harus paling akhir.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
