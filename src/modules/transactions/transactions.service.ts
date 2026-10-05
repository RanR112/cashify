import { AppError } from '../../shared/errors/AppError.js';
import { jakartaDayStartUtc, toJakartaDate } from '../../shared/utils/timezone.js';
import { decodeCursor, encodeCursor } from '../../shared/utils/cursor.js';
import { cursorPayloadSchema } from './transactions.schema.js';
import type {
  AuditContext,
  CreateTransactionInput,
  ListTransactionsQuery,
  TransactionBody,
  TransactionDetailBody,
  TransactionDetailRecord,
  TransactionPatch,
  TransactionRecord,
  TransactionsRepository,
  UpdateTransactionInput,
  WhatsappTransactionInput,
} from './transactions.types.js';

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

export function toTransactionBody(record: TransactionRecord): TransactionBody {
  return {
    id: record.id,
    type: record.type as TransactionBody['type'],
    amount: record.amount,
    date: toDateString(record.date),
    description: record.description,
    source: record.source as TransactionBody['source'],
    category: {
      id: record.category.id,
      name: record.category.name,
      icon: record.category.icon,
      color: record.category.color,
    },
    account: { id: record.account.id, name: record.account.name },
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

function toDetailBody(record: TransactionDetailRecord): TransactionDetailBody {
  // `source_message` hanya untuk transaksi dari WhatsApp. Transaksi lain tidak pernah punya
  // sourceMessageId, tetapi source dicek juga supaya kontraknya tidak bergantung pada itu.
  const message = record.source === 'whatsapp' ? record.sourceMessage : null;
  return {
    ...toTransactionBody(record),
    source_message: message ? { body: message.body, received_at: message.createdAt.toISOString() } : null,
  };
}

export function createTransactionsService(repository: TransactionsRepository) {
  async function assertCategory(userId: string, categoryId: string, type: string): Promise<void> {
    const category = await repository.findVisibleCategory(userId, categoryId);
    if (!category) throw AppError.notFound('Kategori tidak ditemukan');
    if (category.type !== type) {
      throw AppError.validation('Tipe kategori tidak cocok dengan tipe transaksi', [
        { field: 'category_id', issue: 'type_mismatch' },
      ]);
    }
  }

  async function assertAccount(userId: string, accountId: string): Promise<void> {
    if (!(await repository.findOwnedAccount(userId, accountId))) throw AppError.notFound('Akun tidak ditemukan');
  }

  const staleError = () =>
    AppError.conflict('Transaksi sudah berubah sejak terakhir Anda baca. Muat ulang, lalu coba lagi.', [
      { field: 'updated_at', issue: 'stale' },
    ]);

  return {
    async list(userId: string, query: ListTransactionsQuery) {
      const { cursor, limit, category_id, account_id, ...rest } = query;
      const after = cursor ? decodeCursor(cursor, cursorPayloadSchema) : undefined;

      // Satu baris ekstra menjawab "ada halaman berikutnya?" tanpa kueri COUNT.
      const rows = await repository.list(userId, {
        filters: { ...rest, categoryId: category_id, accountId: account_id },
        after: after && { date: after.d, id: after.i },
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit;

      return {
        data: page.map(toTransactionBody),
        next_cursor: hasMore && last ? encodeCursor({ d: toDateString(last.date), i: last.id }) : null,
        has_more: hasMore,
      };
    },

    async get(userId: string, id: string): Promise<TransactionDetailBody> {
      const record = await repository.findById(userId, id);
      if (!record) throw AppError.notFound('Transaksi tidak ditemukan');
      return toDetailBody(record);
    },

    async create(userId: string, input: CreateTransactionInput, audit: AuditContext): Promise<TransactionBody> {
      await assertCategory(userId, input.category_id, input.type);
      await assertAccount(userId, input.account_id);

      const record = await repository.create(
        userId,
        {
          type: input.type,
          amount: input.amount,
          categoryId: input.category_id,
          accountId: input.account_id,
          // Hanya tanggal yang dikirim klien; waktunya awal hari Jakarta. Kolom `date` diturunkan DB.
          occurredAt: jakartaDayStartUtc(input.date),
          description: input.description ?? null,
        },
        audit,
      );
      return toTransactionBody(record);
    },

    /** Jalur alur percakapan WhatsApp: sumber `whatsapp`, audit oleh aktor `whatsapp`. */
    async createFromWhatsapp(userId: string, input: WhatsappTransactionInput): Promise<TransactionBody> {
      await assertCategory(userId, input.categoryId, input.type);
      await assertAccount(userId, input.accountId);

      const record = await repository.create(
        userId,
        {
          type: input.type,
          amount: input.amount,
          categoryId: input.categoryId,
          accountId: input.accountId,
          // Transaksi hari ini menyimpan jam pesan; tanggal lain (mis. "kemarin") awal hari Jakarta.
          occurredAt: toJakartaDate(input.messageTime) === input.date ? input.messageTime : jakartaDayStartUtc(input.date),
          description: input.description,
          source: 'whatsapp',
          sourceMessageId: input.sourceMessageId,
        },
        { ipAddress: null, actor: 'whatsapp' },
      );
      return toTransactionBody(record);
    },

    async findBySourceMessage(userId: string, sourceMessageId: string): Promise<TransactionBody | null> {
      const record = await repository.findBySourceMessage(userId, sourceMessageId);
      return record ? toTransactionBody(record) : null;
    },

    /** Transaksi WhatsApp terakhir dalam 24 jam, kandidat "hapus transaksi terakhir". */
    async latestFromWhatsapp(userId: string, now: Date): Promise<TransactionBody | null> {
      const record = await repository.findLatestFromWhatsapp(userId, new Date(now.getTime() - 24 * 60 * 60 * 1000));
      return record ? toTransactionBody(record) : null;
    },

    topCategoryIds: (userId: string, type: 'income' | 'expense', sinceDate: string, limit: number) =>
      repository.topCategoryIds(userId, type, sinceDate, limit),

    async update(
      userId: string,
      id: string,
      input: UpdateTransactionInput,
      audit: AuditContext,
    ): Promise<TransactionBody> {
      const expectedUpdatedAt = new Date(input.updated_at);
      const existing = await repository.findById(userId, id);
      if (!existing) throw AppError.notFound('Transaksi tidak ditemukan');
      // Jalur cepat; repository memeriksa ulang di bawah kunci baris, itu yang menentukan.
      if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) throw staleError();

      // Tipe dan kategori harus tetap cocok: dicek bila salah satunya berubah.
      const type = input.type ?? (existing.type as 'income' | 'expense');
      const categoryId = input.category_id ?? existing.categoryId;
      if (type !== existing.type || categoryId !== existing.categoryId) {
        await assertCategory(userId, categoryId, type);
      }
      if (input.account_id !== undefined && input.account_id !== existing.accountId) {
        await assertAccount(userId, input.account_id);
      }

      const patch: TransactionPatch = {
        ...(input.type !== undefined && { type: input.type }),
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.category_id !== undefined && { categoryId: input.category_id }),
        ...(input.account_id !== undefined && { accountId: input.account_id }),
        ...(input.description !== undefined && { description: input.description }),
        // Tanggal yang sama tidak menyentuh occurred_at: transaksi WhatsApp menyimpan jam aslinya.
        ...(input.date !== undefined &&
          input.date !== toDateString(existing.date) && { occurredAt: jakartaDayStartUtc(input.date) }),
      };

      const outcome = await repository.update(userId, id, expectedUpdatedAt, patch, audit);
      if (outcome.status === 'not_found') throw AppError.notFound('Transaksi tidak ditemukan');
      if (outcome.status === 'conflict') throw staleError();
      return toTransactionBody(outcome.record);
    },

    async remove(userId: string, id: string, audit: AuditContext): Promise<void> {
      if (!(await repository.softDelete(userId, id, audit))) throw AppError.notFound('Transaksi tidak ditemukan');
    },

    async restore(userId: string, id: string, audit: AuditContext): Promise<TransactionBody> {
      const record = await repository.restore(userId, id, audit);
      if (!record) throw AppError.notFound('Transaksi tidak ditemukan');
      return toTransactionBody(record);
    },
  };
}

export type TransactionsService = ReturnType<typeof createTransactionsService>;
