// Seed pengguna demo: akun Supabase Auth, dua dompet, dan transaksi 3 bulan terakhir.
// Datanya sendiri dirakit di seed-demo-data.ts (murni); berkas ini hanya urusan database.
//
// Dua mode:
//  - biasa: pengguna dan dompet find-or-create; bila pengguna demo sudah punya transaksi,
//    transaksi dilewati (tidak menimpa apa pun, termasuk yang ditambahkan saat demo).
//  - reset: data demo dihapus lebih dulu lalu diisi ulang dengan tanggal relatif terhadap
//    hari ini. Ini alat khusus demo, bukan jalur aplikasi, jadi penghapusannya permanen dan
//    hanya menyentuh baris milik pengguna demo.
//
// Pengguna dibuat lewat AuthProvider yang sama dengan aplikasi (`src/lib/auth.ts`), disuntik
// supaya test integrasi bisa memakai FakeAuthProvider tanpa jaringan.

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthIdentity, AuthProvider, SignUpResult } from '../src/lib/auth.js';
import { createAuthRepository } from '../src/modules/auth/auth.repository.js';
import { isAppError } from '../src/shared/errors/AppError.js';
import { jakartaDayStartUtc, todayInJakarta } from '../src/shared/utils/timezone.js';
import {
  buildDemoDataset,
  DEMO_ACCOUNTS,
  DEMO_FULL_NAME,
  DEMO_INITIAL_BALANCE,
  DEMO_WA_CHAT_ID,
  DEMO_WA_SESSION_ID,
  type DemoTransactionSpec,
} from './seed-demo-data.js';
import { SYSTEM_CATEGORIES } from './seed-data.js';

export interface SeedDemoOptions {
  email: string;
  password: string;
  /** Hapus data demo lebih dulu, lalu isi ulang. */
  reset: boolean;
  /** Bisa disuntik untuk test; bawaannya sekarang. */
  now?: Date;
}

export interface SeedDemoResult {
  userId: string;
  /** False bila transaksi dilewati karena pengguna demo sudah punya data. */
  seededTransactions: boolean;
  existingTransactions: number;
  transactions: number;
  deletedTransactions: number;
  whatsappMessages: number;
}

const DEFAULT_ACCOUNT_NAME = 'Tunai';

const TRANSACTION_TIMEOUT_MS = 30_000;

/** Petunjuk kategori seperti keluaran LLM: nama kategori huruf kecil ("makanan"). */
const categoryHints = new Map(SYSTEM_CATEGORIES.map((category) => [category.slug, category.name.toLowerCase()]));

const toMillis = (spec: DemoTransactionSpec): number =>
  jakartaDayStartUtc(spec.date).getTime() + spec.minuteOfDay * 60_000;

/** Instan transaksi: pesan WhatsApp membawa jam aslinya; transaksi manual di awal hari (seperti POST /transactions). */
const occurredAtOf = (spec: DemoTransactionSpec): Date =>
  spec.source === 'whatsapp' ? new Date(toMillis(spec)) : jakartaDayStartUtc(spec.date);

async function ensureDemoUser(prisma: PrismaClient, provider: AuthProvider, options: SeedDemoOptions) {
  const credentials = { email: options.email, password: options.password };

  let identity: AuthIdentity;
  try {
    ({ identity } = await provider.signInWithPassword(credentials));
  } catch (error) {
    if (!isAppError(error) || error.code !== 'UNAUTHORIZED') throw error;

    // Belum ada akun (atau password berbeda; untuk kasus itu signUp menolak di bawah).
    let signedUp: SignUpResult;
    try {
      signedUp = await provider.signUp({ ...credentials, fullName: DEMO_FULL_NAME });
    } catch (signUpError) {
      if (isAppError(signUpError) && signUpError.code === 'CONFLICT') {
        throw new Error(
          `Akun ${options.email} sudah ada di Supabase tetapi password-nya bukan yang di seed. ` +
            'Setel ulang password-nya di dashboard Supabase, atau pakai DEMO_EMAIL/DEMO_PASSWORD lain di .env.',
        );
      }
      throw signUpError;
    }
    if (!signedUp.session) {
      throw new Error(
        'Supabase tidak menerbitkan sesi saat mendaftarkan pengguna demo; matikan konfirmasi email ' +
          '(Authentication -> Providers -> Email), hapus akun demo yang belum terkonfirmasi, lalu ulangi.',
      );
    }
    identity = signedUp.identity;
  }

  const repository = createAuthRepository(prisma);
  const existing = await repository.findUserById(identity.id);
  if (existing?.deletedAt) throw new Error(`Pengguna demo ${options.email} sudah di-soft-delete; hapus akunnya di Supabase.`);
  return (
    existing ??
    (await repository.provisionNewUser({
      id: identity.id,
      fullName: DEMO_FULL_NAME,
      avatarUrl: null,
      initialBalance: DEMO_INITIAL_BALANCE,
    }))
  );
}

async function wipeDemoData(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Urutan mengikuti FK: transaksi menunjuk message_logs dan accounts.
  await tx.auditLog.deleteMany({ where: { userId } });
  await tx.transaction.deleteMany({ where: { userId } });
  await tx.messageLog.deleteMany({ where: { userId } });
  await tx.account.deleteMany({ where: { userId, isDefault: false } });
  await tx.user.update({
    where: { id: userId },
    data: { fullName: DEMO_FULL_NAME, initialBalance: DEMO_INITIAL_BALANCE, deletedAt: null },
  });
}

/** Dompet bawaan ("Tunai") dibuat saat provisioning; yang lain dibuat bila belum ada. */
async function ensureAccounts(tx: Prisma.TransactionClient, userId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const { name, type } of DEMO_ACCOUNTS) {
    const existing = await tx.account.findFirst({ where: { userId, name, deletedAt: null }, select: { id: true } });
    const account =
      existing ??
      (await tx.account.create({
        data: { userId, name, type, isDefault: name === DEFAULT_ACCOUNT_NAME },
        select: { id: true },
      }));
    ids.set(name, account.id);
  }
  return ids;
}

export async function seedDemo(
  prisma: PrismaClient,
  provider: AuthProvider,
  options: SeedDemoOptions,
): Promise<SeedDemoResult> {
  const user = await ensureDemoUser(prisma, provider, options);
  const today = todayInJakarta(options.now ?? new Date());
  const dataset = buildDemoDataset(today);

  return prisma.$transaction(
    async (tx) => {
      if (options.reset) await wipeDemoData(tx, user.id);

      const accountIds = await ensureAccounts(tx, user.id);

      const existingTransactions = await tx.transaction.count({ where: { userId: user.id } });
      if (existingTransactions > 0) {
        return {
          userId: user.id,
          seededTransactions: false,
          existingTransactions,
          transactions: 0,
          deletedTransactions: 0,
          whatsappMessages: 0,
        };
      }

      // Bila transaksi dihapus manual tetapi pesannya tertinggal, wa_message_id akan bertabrakan.
      await tx.messageLog.deleteMany({ where: { userId: user.id, sessionId: DEMO_WA_SESSION_ID } });

      const categories = await tx.category.findMany({
        where: { userId: user.id, deletedAt: null },
        select: { id: true, slug: true },
      });
      const categoryIds = new Map(categories.map((category) => [category.slug, category.id]));

      const rows = dataset.transactions.map((spec) => {
        const accountId = accountIds.get(spec.account);
        const categoryId = categoryIds.get(spec.categorySlug);
        if (!accountId) throw new Error(`Dompet demo tidak ditemukan: ${spec.account}`);
        if (!categoryId) throw new Error(`Kategori pengguna demo tidak ditemukan: ${spec.categorySlug}`);
        return { spec, id: randomUUID(), accountId, categoryId, messageId: spec.source === 'whatsapp' ? randomUUID() : null };
      });

      await tx.messageLog.createMany({
        data: rows.flatMap(({ spec, messageId }) => {
          if (!messageId || spec.whatsappBody === null || spec.whatsappSeq === null) return [];
          const receivedAt = new Date(toMillis(spec));
          return [
            {
              id: messageId,
              userId: user.id,
              sessionId: DEMO_WA_SESSION_ID,
              waMessageId: `demo-wa-${String(spec.whatsappSeq).padStart(3, '0')}`,
              waChatId: DEMO_WA_CHAT_ID,
              direction: 'inbound',
              body: spec.whatsappBody,
              messageType: 'chat',
              // Bentuk payload OpenWA v4 belum direkam (spike P0), jadi tidak ditebak di sini.
              intent: 'CREATE_TRANSACTION',
              // Hanya field kontrak keluaran LLM; tanpa amount dan date (aturan 2).
              parseResult: {
                intent: 'CREATE_TRANSACTION',
                type: spec.type,
                category_hint: categoryHints.get(spec.categorySlug) ?? null,
                description: spec.description,
              },
              status: 'processed',
              createdAt: receivedAt,
              processedAt: new Date(receivedAt.getTime() + 1200),
            },
          ];
        }),
      });

      await tx.transaction.createMany({
        data: rows.map(({ spec, id, accountId, categoryId, messageId }) => {
          const occurredAt = occurredAtOf(spec);
          // createdAt mengikuti kejadian, bukan waktu seed, supaya urutan "terbaru" masuk akal.
          // Pesan WhatsApp diproses ~1 detik kemudian.
          const createdAt = spec.source === 'whatsapp' ? new Date(occurredAt.getTime() + 1500) : occurredAt;
          return {
            id,
            userId: user.id,
            accountId,
            categoryId,
            type: spec.type,
            amount: spec.amount,
            occurredAt,
            description: spec.description,
            source: spec.source,
            sourceMessageId: messageId,
            createdAt,
            updatedAt: createdAt,
            deletedAt: spec.deletedAt,
          };
        }),
      });

      // Jejak audit seperti yang akan ditulis service transaksi: create untuk semua, delete bila perlu.
      await tx.auditLog.createMany({
        data: rows.flatMap(({ spec, id, accountId, categoryId }) => {
          const actorType = spec.source === 'whatsapp' ? 'whatsapp' : 'user';
          const createdAt = occurredAtOf(spec);
          const entries: Prisma.AuditLogCreateManyInput[] = [
            {
              userId: user.id,
              entityType: 'transaction',
              entityId: id,
              action: 'create',
              changes: {
                after: {
                  type: spec.type,
                  amount: spec.amount,
                  date: spec.date,
                  description: spec.description,
                  category_id: categoryId,
                  account_id: accountId,
                },
              },
              actorType,
              createdAt,
            },
          ];
          if (spec.deletedAt) {
            entries.push({
              userId: user.id,
              entityType: 'transaction',
              entityId: id,
              action: 'delete',
              changes: { before: { deleted_at: null }, after: { deleted_at: spec.deletedAt.toISOString() } },
              actorType,
              createdAt: spec.deletedAt,
            });
          }
          return entries;
        }),
      });

      return {
        userId: user.id,
        seededTransactions: true,
        existingTransactions: 0,
        transactions: rows.length,
        deletedTransactions: rows.filter(({ spec }) => spec.deletedAt).length,
        whatsappMessages: rows.filter(({ messageId }) => messageId).length,
      };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}
