// Tipe internal modul budgets. Bentuk request/response ada di budgets.schema.ts.
//
// Anggaran membaca pengeluaran lewat port `SpendingReader` di bawah ini; implementasinya
// ada di transactions.summary.ts dan dirakit di src/app.ts. Karena modul tidak boleh saling
// impor, berkas ini mendefinisikan bentuk data sendiri dan tidak mengimpor transactions.

import type { z } from 'zod';
import type {
  budgetDetailSchema,
  budgetListQuerySchema,
  budgetListSchema,
  budgetSchema,
  budgetSummarySchema,
  createBudgetBodySchema,
  updateBudgetBodySchema,
} from './budgets.schema.js';

export type BudgetBody = z.infer<typeof budgetSchema>;
export type BudgetDetailBody = z.infer<typeof budgetDetailSchema>;
export type BudgetListBody = z.infer<typeof budgetListSchema>;
export type BudgetSummaryBody = z.infer<typeof budgetSummarySchema>;
export type CreateBudgetInput = z.infer<typeof createBudgetBodySchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetBodySchema>;
export type BudgetListQuery = z.infer<typeof budgetListQuerySchema>;

export type BudgetPeriodType = 'monthly' | 'weekly';
export type BudgetStatus = 'ok' | 'warning' | 'over';

/** Satu alokasi kategori setelah nilai bawaan diselesaikan service. */
export interface CategoryAllocation {
  categoryId: string;
  amount: number;
  alertThreshold: number;
}

/** Baris budget_categories beserta kategori yang dirujuk. */
export interface BudgetCategoryRecord {
  /** `budget_categories.id`; dipakai jobId peringatan, bukan response HTTP. */
  id: string;
  categoryId: string;
  amount: number;
  alertThreshold: number;
  alertSentAt: Date | null;
  category: { name: string; slug: string };
}

/** Baris budgets beserta seluruh alokasinya. `budget_categories` tidak punya user_id. */
export interface BudgetRecord {
  id: string;
  /** Pemilik; dipakai job terjadwal yang memindai banyak pengguna. */
  userId: string;
  name: string | null;
  periodType: string;
  periodStart: Date;
  periodEnd: Date;
  totalAmount: number;
  autoRenew: boolean;
  rolloverEnabled: boolean;
  createdAt: Date;
  budgetCategories: BudgetCategoryRecord[];
}

/** Data lengkap untuk membuat anggaran; `period_end` sudah dihitung service. */
export interface BudgetWriteData {
  name: string | null;
  periodType: BudgetPeriodType;
  /** `YYYY-MM-DD`. */
  periodStart: string;
  /** `YYYY-MM-DD`. */
  periodEnd: string;
  totalAmount: number;
  autoRenew: boolean;
  rolloverEnabled: boolean;
  categories: CategoryAllocation[];
}

/** Field yang boleh diubah lewat PATCH; `undefined` berarti tidak diubah. */
export interface BudgetPatch {
  name?: string;
  totalAmount?: number;
  autoRenew?: boolean;
  rolloverEnabled?: boolean;
  categories?: CategoryAllocation[];
}

/** Kolom audit_logs.ip_address bertipe INET; controller sudah menyaring nilai bukan IP. */
export interface AuditContext {
  ipAddress: string | null;
}

/** Kategori yang terlihat pengguna, dipakai service untuk memvalidasi alokasi. */
export interface VisibleCategory {
  id: string;
  name: string;
  slug: string;
  type: string;
}

// ---- port pembaca pengeluaran ----

/** Rentang tanggal kalender inklusif, `YYYY-MM-DD`. */
export interface SpendingRange {
  from: string;
  to: string;
}

export interface SpendingSnapshot {
  total: number;
  byCategory: Record<string, number>;
}

/** Implementasi: `transactions.summary.ts` (`spendingInRange`), dirakit di src/app.ts. */
export interface SpendingReader {
  spendingInRange(userId: string, range: SpendingRange): Promise<SpendingSnapshot>;
}

// ---- port job terjadwal ----

/**
 * Akun WhatsApp yang dipindai job. Sama seperti port notifications: implementasi hanya
 * membaca baris, sedangkan kelayakan (verified, sakelar, pengguna tidak soft-delete) tetap
 * diputuskan service budgets. `accountId` hanya untuk paginasi.
 */
export interface BudgetAlertAccount {
  accountId: string;
  userId: string;
  waChatId: string;
  status: string;
  budgetAlertEnabled: boolean;
  userDeletedAt: Date | null;
}

export interface BudgetAlertAudience {
  list(afterAccountId: string | null, limit: number): Promise<BudgetAlertAccount[]>;
}

/** Satu kategori yang layak diberi peringatan; notifier yang merender teks dan menyimpan. */
export interface BudgetAlertNotice {
  userId: string;
  waChatId: string;
  budgetId: string;
  /** `budget_categories.id` untuk jobId deterministik. */
  budgetCategoryId: string;
  /** `categories.id` untuk payload notifikasi. */
  categoryId: string;
  budgetName: string | null;
  categoryName: string;
  spent: number;
  amount: number;
  /** Awal periode `YYYY-MM-DD`. */
  periodStart: string;
  now: Date;
}

/** Implementasi: notifications.service, dirakit di composition root worker. */
export interface BudgetAlertNotifier {
  deliver(notice: BudgetAlertNotice): Promise<'sent' | 'skipped'>;
}

export interface BudgetsScheduledDeps {
  audience: BudgetAlertAudience;
  notifier: BudgetAlertNotifier;
}

export interface BudgetScanResult {
  sent: number;
  skipped: number;
}

export interface RenewResult {
  created: number;
  skipped: number;
}

// ---- repository ----

export type CreateOutcome = { status: 'created'; record: BudgetRecord } | { status: 'conflict' };

export type UpdateOutcome =
  | { status: 'updated'; record: BudgetRecord }
  | { status: 'not_found' }
  | { status: 'conflict' };

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface BudgetsRepository {
  /** `active` = periode memuat `today` (WIB), urut `period_start` menurun. */
  list(userId: string, status: 'active' | 'all', today: string): Promise<BudgetRecord[]>;
  findById(userId: string, id: string): Promise<BudgetRecord | null>;
  /** Anggaran yang periodenya memuat `today`; null bila tidak ada. */
  findActive(userId: string, today: string): Promise<BudgetRecord | null>;
  /** Anggaran lain yang periodenya beririsan dengan rentang, kecuali `excludeId`. */
  findOverlapping(
    userId: string,
    from: string,
    to: string,
    excludeId?: string,
  ): Promise<{ id: string } | null>;
  findVisibleCategories(userId: string, ids: string[]): Promise<VisibleCategory[]>;
  create(userId: string, data: BudgetWriteData, audit: AuditContext): Promise<CreateOutcome>;
  update(userId: string, id: string, patch: BudgetPatch, audit: AuditContext): Promise<UpdateOutcome>;
  softDelete(userId: string, id: string, audit: AuditContext): Promise<boolean>;
  /**
   * Khusus job `renew-budgets`: seluruh anggaran auto_renew yang periodenya sudah lewat,
   * urut pengguna lalu periode terbaru. Sengaja tanpa filter user_id karena memindai semua
   * pengguna; tidak pernah dipakai untuk request HTTP.
   */
  listDueRenewals(today: string): Promise<BudgetRecord[]>;
  /** Salinan anggaran untuk periode berjalan; audit ditulis sebagai actor_type 'system'. */
  createRenewal(userId: string, data: BudgetWriteData): Promise<CreateOutcome>;
}
