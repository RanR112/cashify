// Tipe internal modul notifications. Bentuk request/response ada di notifications.schema.ts.
//
// Modul ini tidak mengimpor modul lain. Worker outbound mengenal satu-satunya port di bawah
// (`NotificationStatusPort`), yang implementasinya dirakit di src/workers/pipeline.ts.

import type { z } from 'zod';
import type {
  listNotificationsQuerySchema,
  notificationListSchema,
  notificationSchema,
} from './notifications.schema.js';

export type NotificationBody = z.infer<typeof notificationSchema>;
export type NotificationListBody = z.infer<typeof notificationListSchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export type NotificationType = NotificationBody['type'];
export type NotificationChannel = NotificationBody['channel'];
export type NotificationStatus = NotificationBody['status'];

/**
 * Isi `payload` hanya id dan tanggal (PHASE2-DECISIONS §5.11): tidak pernah nomor telepon,
 * OTP, isi pesan, atau alasan kegagalan. Nilainya tidak pernah masuk response API.
 */
export type NotificationPayload = Record<string, string>;

export interface NotificationRecord {
  id: string;
  /** Kolom VARCHAR; nilainya dijaga kode dan Zod. */
  type: string;
  channel: string;
  title: string;
  body: string;
  status: string;
  scheduledFor: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface CreatePendingInput {
  type: NotificationType;
  title: string;
  body: string;
  payload: NotificationPayload;
  /** Null/undefined berarti langsung siap dikirim. */
  scheduledFor?: Date | null;
}

export interface ListNotificationsOptions {
  status?: NotificationStatus;
  /** Satu baris lebih dari batas halaman, dipakai service untuk menghitung `has_more`. */
  limit: number;
  /** Cursor halaman sebelumnya, urut `created_at DESC, id DESC`. */
  before?: { createdAt: Date; id: string };
}

/** Hasil transisi status; service menerjemahkan `not_found`/`conflict` menjadi AppError. */
export type MarkReadOutcome =
  | { status: 'read'; record: NotificationRecord }
  | { status: 'not_found' }
  | { status: 'conflict' };

export interface NotificationsRepository {
  createPending(userId: string, input: CreatePendingInput): Promise<{ id: string }>;
  list(userId: string, options: ListNotificationsOptions): Promise<NotificationRecord[]>;
  markRead(userId: string, id: string): Promise<MarkReadOutcome>;
  /** Hanya dari `pending`; `false` berarti baris tidak ada atau sudah berpindah status. */
  markSent(notificationId: string): Promise<boolean>;
  /** Hanya dari `pending`; `false` berarti baris tidak ada atau sudah berpindah status. */
  markFailed(notificationId: string): Promise<boolean>;
}

/**
 * Port untuk worker outbound (dirakit di src/workers/pipeline.ts).
 *
 * `reason` adalah kode tertutup pilihan worker (`send_failed`, `expired`, `invalid_job`),
 * bukan pesan galat gateway: isinya hanya untuk log dan tidak pernah disimpan atau diekspos.
 */
export interface NotificationStatusPort {
  markSent(notificationId: string): Promise<void>;
  markFailed(notificationId: string, reason: NotificationFailureReason): Promise<void>;
}

export type NotificationFailureReason = 'send_failed' | 'expired' | 'invalid_job';

// ---- job terjadwal (antrean `scheduled`) ----
//
// Port di bawah ini sengaja didefinisikan di modul notifications: implementasinya dirakit
// di composition root worker (`src/workers/scheduled.ts`), bukan diimpor dari modul lain.

/**
 * Satu akun WhatsApp yang dipindai job. Port hanya membaca baris; keputusan kelayakan
 * (status verified, sakelar menyala, pengguna belum soft-delete) tetap di service.
 * `accountId` dipakai untuk paginasi cursor, bukan untuk response HTTP.
 */
export interface ScheduledAccountCandidate {
  accountId: string;
  userId: string;
  waChatId: string;
  status: string;
  dailySummaryEnabled: boolean;
  budgetAlertEnabled: boolean;
  userDeletedAt: Date | null;
}

export interface DailySummaryAudience {
  /** Satu halaman akun, urut `accountId` menaik. */
  list(afterAccountId: string | null, limit: number): Promise<ScheduledAccountCandidate[]>;
}

export interface DailySummaryStats {
  income: number;
  expense: number;
  topExpenseCategory: { name: string; total: number } | null;
}

/** Implementasi: `transactions.summary.ts`, dirakit di composition root worker. */
export interface DailySummaryReader {
  dailyStats(userId: string, date: string): Promise<DailySummaryStats>;
}

/** Pesan yang siap dimasukkan ke antrean `outbound`; bukan panggilan gateway langsung. */
export interface ScheduledMessage {
  waChatId: string;
  text: string;
  notificationId: string;
  /** `daily:{user_id}:{YYYY-MM-DD}` atau `alert:{budget_category_id}:{period_start}`. */
  jobId: string;
  /** Jitter ringkasan harian; 0/undefined berarti langsung. */
  delayMs?: number;
  scheduledFor?: Date | null;
}

export type ScheduledMessageSender = (message: ScheduledMessage) => Promise<void>;

export type DailySummaryCreateOutcome = { status: 'created'; id: string } | { status: 'exists' };

export interface CreateDailySummaryInput {
  title: string;
  body: string;
  /** Tanggal kalender WIB, `YYYY-MM-DD`; menjadi `payload.date`. */
  date: string;
  scheduledFor?: Date | null;
}

/**
 * Operasi satu tabel `notifications` untuk job terjadwal. Cek + create dipakai bersama
 * unique expression index `(user_id, type, payload->>'date')` sebagai lapis kedua.
 */
export interface NotificationsScheduledStore {
  findDailySummary(userId: string, date: string): Promise<{ id: string } | null>;
  createDailySummary(userId: string, input: CreateDailySummaryInput): Promise<DailySummaryCreateOutcome>;
  /** Notifikasi otomatis hari itu yang masih mungkin terkirim (pending/sent/read). */
  countAutomaticOnDate(userId: string, date: string): Promise<number>;
}

/**
 * Transaksi dua tabel: compare-and-set `budget_categories.alert_sent_at` lalu insert
 * `notifications`. Implementasi di `src/workers/scheduled.ports.ts` supaya modul
 * notifications dan budgets tidak saling mengimpor.
 */
export interface BudgetAlertClaimInput {
  userId: string;
  budgetId: string;
  /** Baris `budget_categories.id`; compare-and-set memakai id ini. */
  budgetCategoryId: string;
  categoryId: string;
  now: Date;
  title: string;
  body: string;
  payload: NotificationPayload;
}

export type BudgetAlertClaimOutcome =
  | { status: 'created'; notificationId: string }
  | { status: 'already_sent' };

export interface BudgetAlertClaimStore {
  claim(input: BudgetAlertClaimInput): Promise<BudgetAlertClaimOutcome>;
  /** Enqueue gagal: `pending -> failed` dan `alert_sent_at` kembali NULL. */
  release(input: {
    userId: string;
    budgetId: string;
    budgetCategoryId: string;
    categoryId: string;
    notificationId: string;
    claimedAt: Date;
  }): Promise<void>;
}

/** Data keputusan dari modul budgets; notifications hanya merender teks dan menyimpan. */
export interface BudgetAlertDelivery {
  userId: string;
  waChatId: string;
  budgetId: string;
  /** Baris `budget_categories.id`, dipakai untuk jobId deterministik. */
  budgetCategoryId: string;
  /** `categories.id`, dipakai untuk payload notifikasi. */
  categoryId: string;
  budgetName: string | null;
  categoryName: string;
  spent: number;
  amount: number;
  /** Awal periode `YYYY-MM-DD`. */
  periodStart: string;
  now: Date;
}

export interface NotificationsScheduledDeps {
  store: NotificationsScheduledStore;
  budgetAlerts: BudgetAlertClaimStore;
  audience: DailySummaryAudience;
  summary: DailySummaryReader;
  sender: ScheduledMessageSender;
  /** Penyuntik acak untuk test jitter; bawaan Math.random. */
  rng?: () => number;
}

export interface DailySummaryRunResult {
  /** Akun yang lolos sakelar/verifikasi, sebelum batas harian dan isi transaksi. */
  targeted: number;
  /** Notifikasi yang berhasil masuk antrean outbound. */
  sent: number;
  /** Dilewati karena sakelar, cap, duplikat, tanpa transaksi, atau gagal enqueue. */
  skipped: number;
}

export interface NotificationsService {
  /** Membuat satu baris `pending` untuk kanal WhatsApp dan mengembalikan id-nya. */
  createWhatsapp(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    payload: NotificationPayload,
    scheduledFor?: Date | null,
  ): Promise<string>;
  list(userId: string, query: ListNotificationsQuery): Promise<NotificationListBody>;
  markRead(userId: string, id: string): Promise<NotificationBody>;
  /** Job `daily-summary`: pindai akun, buat notifikasi, masukkan ke outbound. */
  runDailySummary(now: Date): Promise<DailySummaryRunResult>;
  /** Job `budget-alert`: klaim atomik lalu masukkan ke outbound. */
  deliverBudgetAlert(input: BudgetAlertDelivery): Promise<'sent' | 'skipped'>;
}

/** Repository nyata mengimplementasikan operasi terjadwal; test lama cukup memakai NotificationsRepository. */
export interface NotificationsScheduledRepository
  extends NotificationsRepository,
    NotificationsScheduledStore {}
