import type { z } from 'zod';
import type { TransactionsService } from '../transactions/transactions.service.js';
import type { TransactionsSummary } from '../transactions/transactions.summary.js';
import type { UsersService } from '../users/users.service.js';
import type { dashboardQuerySchema, dashboardResponseSchema } from './dashboard.schema.js';

export type DashboardBody = z.infer<typeof dashboardResponseSchema>;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// Dashboard tidak punya repository: ia hanya menggabungkan service lain. Dependensinya
// dipersempit ke metode yang benar-benar dipakai supaya mudah difake di test.
export type DashboardUsers = Pick<UsersService, 'getMe'>;
export type DashboardTransactions = Pick<TransactionsService, 'list'>;
export type DashboardSummary = Pick<TransactionsSummary, 'sumByType' | 'dailyCashflow'>;
