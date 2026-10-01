import type { z } from 'zod';
import type {
  createTransactionBodySchema,
  listTransactionsQuerySchema,
  transactionDetailSchema,
  transactionSchema,
  updateTransactionBodySchema,
} from './transactions.schema.js';

export type TransactionBody = z.infer<typeof transactionSchema>;
export type TransactionDetailBody = z.infer<typeof transactionDetailSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionBodySchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionBodySchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

export interface TransactionRecord {
  id: string;
  type: string;
  amount: number;
  /** Kolom `date` (generated column): tanggal kalender Jakarta, disimpan sebagai tengah malam UTC. */
  date: Date;
  occurredAt: Date;
  description: string | null;
  source: string;
  categoryId: string;
  accountId: string;
  category: { id: string; name: string; icon: string; color: string };
  account: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionDetailRecord extends TransactionRecord {
  sourceMessage: { body: string | null; createdAt: Date } | null;
}

/** Konteks pencatatan audit; diisi controller supaya service tidak mengenal Express. */
export interface AuditContext {
  ipAddress: string | null;
}

export interface TransactionFilters {
  from?: string | undefined;
  to?: string | undefined;
  type?: 'income' | 'expense' | undefined;
  categoryId?: string | undefined;
  accountId?: string | undefined;
  source?: TransactionBody['source'] | undefined;
  q?: string | undefined;
}

export interface ListParams {
  filters: TransactionFilters;
  /** Posisi cursor: baris yang diambil adalah yang tepat setelah (date, id) ini. */
  after?: { date: string; id: string } | undefined;
  limit: number;
}

export interface NewTransaction {
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  accountId: string;
  occurredAt: Date;
  description: string | null;
}

/** Field yang diubah PATCH, dalam nama kolom Prisma. `undefined` berarti tidak diubah. */
export interface TransactionPatch {
  type?: 'income' | 'expense';
  amount?: number;
  categoryId?: string;
  accountId?: string;
  occurredAt?: Date;
  description?: string | null;
}

export type UpdateOutcome =
  | { status: 'updated'; record: TransactionRecord }
  | { status: 'not_found' }
  | { status: 'conflict' };

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface TransactionsRepository {
  list(userId: string, params: ListParams): Promise<TransactionRecord[]>;
  /** Hanya transaksi aktif; yang di-soft-delete dianggap tidak ada. */
  findById(userId: string, id: string): Promise<TransactionDetailRecord | null>;
  create(userId: string, data: NewTransaction, audit: AuditContext): Promise<TransactionRecord>;
  /**
   * Mengunci baris, mencocokkan `expectedUpdatedAt`, lalu menulis perubahan dan audit dalam
   * satu transaksi database. Patch yang tidak mengubah apa pun tidak menulis apa pun.
   */
  update(
    userId: string,
    id: string,
    expectedUpdatedAt: Date,
    patch: TransactionPatch,
    audit: AuditContext,
  ): Promise<UpdateOutcome>;
  /** False bila transaksi tidak ada atau sudah dihapus. */
  softDelete(userId: string, id: string, audit: AuditContext): Promise<boolean>;
  /** Null bila transaksi tidak ada atau belum dihapus. */
  restore(userId: string, id: string, audit: AuditContext): Promise<TransactionRecord | null>;
  /** Kategori milik pengguna atau kategori sistem, belum dihapus. */
  findVisibleCategory(userId: string, categoryId: string): Promise<{ id: string; type: string } | null>;
  findOwnedAccount(userId: string, accountId: string): Promise<{ id: string } | null>;
}
