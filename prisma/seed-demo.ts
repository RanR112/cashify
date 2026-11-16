// Seed pengguna demo: akun Supabase Auth, dua dompet, dan transaksi 3 bulan terakhir.
// Datanya sendiri dirakit di seed-demo-data.ts (murni); berkas ini hanya urusan database.
//
// Dua mode:
//  - biasa: pengguna dan dompet find-or-create; bila pengguna demo sudah punya transaksi,
//    transaksi dilewati (tidak menimpa apa pun, termasuk yang ditambahkan saat demo).
//  - reset: data demo dihapus lebih dulu (transaksi, pesan, audit, dompet tambahan, dan tautan
//    WhatsApp) lalu diisi ulang dengan tanggal relatif terhadap hari ini. Ini alat khusus demo,
//    bukan jalur aplikasi, jadi penghapusannya permanen dan hanya menyentuh baris milik
//    pengguna demo. State Redis pengguna demo dibersihkan di prisma/seed.ts (best-effort).
//
// Pengguna dibuat lewat AuthProvider yang sama dengan aplikasi (`src/lib/auth.ts`), disuntik
// supaya test integrasi bisa memakai FakeAuthProvider tanpa jaringan.

import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthIdentity, AuthProvider, SignUpResult } from '../src/lib/auth.js';
import { createAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createTransactionsSummary, type CategoryTotal } from '../src/modules/transactions/transactions.summary.js';
import { isAppError } from '../src/shared/errors/AppError.js';
import { addDays, jakartaDayStartUtc, monthBounds, todayInJakarta } from '../src/shared/utils/timezone.js';
import {
  buildDemoBudget,
  buildDemoDataset,
  buildDemoNotifications,
  DEMO_ACCOUNTS,
  DEMO_FULL_NAME,
  DEMO_INITIAL_BALANCE,
  DEMO_WA_CHAT_ID,
  DEMO_WA_SESSION_ID,
  type DemoBudgetSpec,
  type DemoCategorySpend,
  type DemoDailyStat,
  type DemoNotificationPayload,
  type DemoNotificationSpec,
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
  /** True bila anggaran bulan berjalan baru dibuat pada jalan ini. */
  budgetCreated: boolean;
  /** Jumlah baris notifications yang baru dibuat (0 bila semuanya sudah ada). */
  notificationsCreated: number;
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

/** `YYYY-MM-DD` -> tengah malam UTC, bentuk yang dipakai Prisma untuk kolom `@db.Date`. */
const dateOf = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Hanya pengeluaran; anggaran tidak memakai kategori pemasukan. */
const expenseSpends = (rows: readonly CategoryTotal[]): DemoCategorySpend[] =>
  rows
    .filter((row) => row.type === 'expense')
    .map(({ categoryId, name, slug, total }) => ({ categoryId, name, slug, total }));

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
  // Urutan mengikuti FK: transaksi menunjuk message_logs dan accounts; budget_categories
  // menunjuk categories ON DELETE RESTRICT sehingga anggaran harus dihapus lebih dulu.
  await tx.auditLog.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  await tx.budget.deleteMany({ where: { userId } });
  await tx.transaction.deleteMany({ where: { userId } });
  await tx.messageLog.deleteMany({ where: { userId } });
  // Tautan WhatsApp hasil latihan demo: tanpa ini, penautan ulang ditolak 409 ("sudah tertaut")
  // dan nomornya tetap terkunci oleh unique index parsial (phone_e164, wa_chat_id) WHERE verified.
  await tx.whatsappVerification.deleteMany({ where: { userId } });
  await tx.whatsappAccount.deleteMany({ where: { userId } });
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

interface EnsuredBudget {
  id: string;
  name: string | null;
  periodStart: string;
  periodEnd: string;
  categories: {
    categoryId: string;
    name: string;
    slug: string;
    amount: number;
    alertThreshold: number;
  }[];
  alertCategoryId: string | null;
  alertSpent: number;
  /** Spec lengkap untuk teks notifikasi; null bila tidak ada kategori warning. */
  spec: DemoBudgetSpec | null;
}

/** Rekonstruksi spec dari anggaran yang sudah ada, khusus untuk teks notifikasi. */
function notificationBudget(budget: EnsuredBudget): DemoBudgetSpec | null {
  if (budget.spec) return budget.spec;
  if (!budget.alertCategoryId) return null;
  return {
    name: budget.name ?? 'Anggaran',
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd,
    totalAmount: budget.categories.reduce((sum, category) => sum + category.amount, 0),
    autoRenew: true,
    rolloverEnabled: false,
    categories: budget.categories,
    alertCategoryId: budget.alertCategoryId,
    alertSpent: budget.alertSpent,
  };
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

interface BudgetPlan {
  /** Anggaran periode berjalan yang sudah ada. */
  existing: EnsuredBudget | null;
  /** Spec yang perlu dibuat; null bila sudah ada atau tidak ada pengeluaran. */
  spec: DemoBudgetSpec | null;
}

/**
 * Anggaran bulan berjalan: pakai yang sudah ada, atau siapkan spec dari pengeluaran aktual.
 * Semua pembacaan dilakukan di luar transaksi tulis, sehingga tidak ada kueri agregat yang
 * menunggu koneksi kedua saat transaksi penulisan sedang terbuka.
 */
async function planBudget(
  prisma: PrismaClient,
  userId: string,
  today: string,
  summary: ReturnType<typeof createTransactionsSummary>,
): Promise<BudgetPlan> {
  const existing = await prisma.budget.findFirst({
    where: {
      userId,
      deletedAt: null,
      periodStart: { lte: dateOf(today) },
      periodEnd: { gte: dateOf(today) },
    },
    select: {
      id: true,
      name: true,
      periodStart: true,
      periodEnd: true,
      budgetCategories: {
        select: {
          categoryId: true,
          amount: true,
          alertThreshold: true,
          category: { select: { name: true, slug: true } },
        },
      },
    },
    orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
  });

  if (existing) {
    const periodStart = isoDate(existing.periodStart);
    const periodEnd = isoDate(existing.periodEnd);
    const spending = await summary.spendingInRange(userId, { from: periodStart, to: periodEnd });

    // Notifikasi peringatan hanya untuk kategori yang benar-benar warning/over.
    let alertCategoryId: string | null = null;
    let alertSpent = 0;
    let bestPercent = 0;
    for (const category of existing.budgetCategories) {
      const spent = spending.byCategory[category.categoryId] ?? 0;
      if (spent <= 0) continue;
      const percent = (spent / category.amount) * 100;
      if (percent < category.alertThreshold || percent > 100) continue;
      if (percent > bestPercent) {
        bestPercent = percent;
        alertCategoryId = category.categoryId;
        alertSpent = spent;
      }
    }

    return {
      existing: {
        id: existing.id,
        name: existing.name,
        periodStart,
        periodEnd,
        categories: existing.budgetCategories.map(({ categoryId, amount, alertThreshold, category }) => ({
          categoryId,
          name: category.name,
          slug: category.slug,
          amount,
          alertThreshold,
        })),
        alertCategoryId,
        alertSpent,
        spec: null,
      },
      spec: null,
    };
  }

  const month = monthBounds(today.slice(0, 7));
  const [currentMonth, recent] = await Promise.all([
    summary.categoryTotals(userId, { from: month.from, to: month.to }),
    summary.categoryTotals(userId, { from: addDays(today, -59), to: today }),
  ]);
  const spec = buildDemoBudget(today, {
    currentMonth: expenseSpends(currentMonth),
    recent: expenseSpends(recent),
  });
  return { existing: null, spec };
}

/** Menulis anggaran baru + audit; tanpa pembacaan agregat di dalam transaksi. */
async function applyBudget(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  plan: BudgetPlan,
): Promise<{ created: boolean; budget: EnsuredBudget | null }> {
  if (plan.existing) return { created: false, budget: plan.existing };
  const spec = plan.spec;
  if (!spec) return { created: false, budget: null };

  const record = await tx.budget.create({
    data: {
      userId,
      name: spec.name,
      periodType: 'monthly',
      periodStart: dateOf(spec.periodStart),
      periodEnd: dateOf(spec.periodEnd),
      totalAmount: spec.totalAmount,
      autoRenew: spec.autoRenew,
      rolloverEnabled: spec.rolloverEnabled,
      budgetCategories: {
        create: spec.categories.map((category) => ({
          categoryId: category.categoryId,
          amount: category.amount,
          alertThreshold: category.alertThreshold,
        })),
      },
    },
    select: { id: true },
  });

  // Jejak audit seperti POST /budgets: hanya field allowlist, tanpa IP.
  await tx.auditLog.create({
    data: {
      userId,
      entityType: 'budget',
      entityId: record.id,
      action: 'create',
      changes: {
        after: {
          name: spec.name,
          period_type: 'monthly',
          period_start: spec.periodStart,
          period_end: spec.periodEnd,
          total_amount: spec.totalAmount,
          auto_renew: spec.autoRenew,
          rollover_enabled: spec.rolloverEnabled,
          categories: spec.categories.map((category) => ({
            category_id: category.categoryId,
            amount: category.amount,
            alert_threshold: category.alertThreshold,
          })),
        },
      },
      actorType: 'user',
      ipAddress: null,
      createdAt: now,
    },
  });

  return {
    created: true,
    budget: {
      id: record.id,
      name: spec.name,
      periodStart: spec.periodStart,
      periodEnd: spec.periodEnd,
      categories: spec.categories,
      alertCategoryId: spec.alertCategoryId,
      alertSpent: spec.alertSpent,
      spec,
    },
  };
}

function sameNotificationPayload(payload: Prisma.JsonValue, spec: DemoNotificationPayload): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  if ('date' in spec) return row.date === spec.date;
  return row.budget_id === spec.budget_id && row.category_id === spec.category_id;
}

/** Riwayat notifikasi demo; baris yang sudah ada (mis. dari job asli) tidak ditimpa. */
async function ensureNotifications(
  tx: Prisma.TransactionClient,
  userId: string,
  specs: readonly DemoNotificationSpec[],
): Promise<number> {
  const existing = await tx.notification.findMany({
    where: { userId },
    select: { type: true, payload: true },
  });

  let created = 0;
  for (const spec of specs) {
    if (existing.some((row) => row.type === spec.type && sameNotificationPayload(row.payload, spec.payload))) {
      continue;
    }
    try {
      await tx.notification.create({
        data: {
          userId,
          type: spec.type,
          channel: 'whatsapp',
          title: spec.title,
          body: spec.body,
          payload: spec.payload as Prisma.InputJsonObject,
          status: spec.status,
          scheduledFor: spec.scheduledFor,
          sentAt: spec.sentAt,
          createdAt: spec.createdAt,
        },
      });
      created += 1;
    } catch (error) {
      // Balapan dengan job asli: unique expression index ringkasan harian menolak duplikat.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }
  return created;
}

export async function seedDemo(
  prisma: PrismaClient,
  provider: AuthProvider,
  options: SeedDemoOptions,
): Promise<SeedDemoResult> {
  const now = options.now ?? new Date();
  const user = await ensureDemoUser(prisma, provider, options);
  const today = todayInJakarta(now);
  const dataset = buildDemoDataset(today);
  const transactionOptions = { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS };

  // Fase 1: dompet dan transaksi. Fase 2 (anggaran/notifikasi) membaca data yang sudah
  // di-commit, supaya persentase anggaran dihitung dari baris yang benar-benar tersimpan.
  const transactionResult = await prisma.$transaction(
    async (tx) => {
      if (options.reset) await wipeDemoData(tx, user.id);

      const accountIds = await ensureAccounts(tx, user.id);

      const existingTransactions = await tx.transaction.count({ where: { userId: user.id } });
      if (existingTransactions > 0) {
        return {
          seededTransactions: false,
          existingTransactions,
          transactions: 0,
          deletedTransactions: 0,
          whatsappMessages: 0,
        };
      }

      // Sesi `demo` milik seed ini saja. Pesan sisa harus dibersihkan tanpa memfilter user_id:
      // menghapus pengguna demo (akun Supabase atau DELETE /me) membuat user_id pesannya NULL
      // (ON DELETE SET NULL), sehingga seed berikutnya menabrak unique (session_id, wa_message_id).
      await tx.messageLog.deleteMany({ where: { sessionId: DEMO_WA_SESSION_ID } });

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
        seededTransactions: true,
        existingTransactions: 0,
        transactions: rows.length,
        deletedTransactions: rows.filter(({ spec }) => spec.deletedAt).length,
        whatsappMessages: rows.filter(({ messageId }) => messageId).length,
      };
    },
    transactionOptions,
  );

  // Fase 2: anggaran bulan berjalan dan riwayat notifikasi. Idempoten: anggaran yang sudah
  // ada dipakai, notifikasi yang sudah ada (termasuk dari job asli) dilewati.
  const summary = createTransactionsSummary(prisma);
  const budgetPlan = await planBudget(prisma, user.id, today, summary);

  // Dua hari terakhir yang punya transaksi; hari ini dikecualikan agar tidak ada
  // notifikasi bertanggal masa depan bila seed dijalankan sebelum pukul 20.05 WIB.
  const cashflow = await summary.dailyCashflow(user.id, {
    from: addDays(today, -7),
    to: addDays(today, -1),
  });
  const dates = cashflow
    .filter((row) => row.income > 0 || row.expense > 0)
    .slice(-2)
    .reverse()
    .map((row) => row.date);

  const dailyStats: DemoDailyStat[] = [];
  for (const date of dates) {
    dailyStats.push({ date, ...(await summary.dailySummary(user.id, date)) });
  }

  // Transaksi tulis hanya berisi INSERT (anggaran, audit, notifikasi); semua agregat sudah
  // dibaca di atas, jadi tidak ada kueri yang menunggu koneksi kedua.
  const secondary = await prisma.$transaction(
    async (tx) => {
      const ensured = await applyBudget(tx, user.id, now, budgetPlan);
      const specs = buildDemoNotifications(today, {
        dailyStats,
        budget: ensured.budget ? notificationBudget(ensured.budget) : null,
        budgetId: ensured.budget?.id ?? null,
      });

      return {
        budgetCreated: ensured.created,
        notificationsCreated: await ensureNotifications(tx, user.id, specs),
      };
    },
    transactionOptions,
  );

  return { userId: user.id, ...transactionResult, ...secondary };
}
