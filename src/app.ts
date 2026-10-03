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

export interface AppDeps {
  /** Klien Prisma untuk modul users, accounts, categories, transactions, dashboard; bawaannya klien tunggal dari lib/database. */
  prisma?: PrismaClient;
  /** Disuntik di test; bawaannya Supabase Auth + Prisma sungguhan. */
  authService?: AuthService;
  /** Pemeriksa Bearer token untuk rute terproteksi; bawaannya JWT Supabase asli. */
  verifyAuth?: RequestHandler;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();

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

  // Konstruktor PrismaClient tidak membuka koneksi, jadi createApp() tanpa .env tetap bisa dimuat.
  const prisma = deps.prisma ?? getPrisma();
  const usersService = createUsersService(createUsersRepository(prisma));
  const transactionsService = createTransactionsService(createTransactionsRepository(prisma));

  app.use('/me', createUsersRouter(usersService, deps.verifyAuth));
  app.use('/accounts', createAccountsRouter(createAccountsService(createAccountsRepository(prisma)), deps.verifyAuth));
  app.use(
    '/categories',
    createCategoriesRouter(createCategoriesService(createCategoriesRepository(prisma)), deps.verifyAuth),
  );
  app.use('/transactions', createTransactionsRouter(transactionsService, deps.verifyAuth));

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
