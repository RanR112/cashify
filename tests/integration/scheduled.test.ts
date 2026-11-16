// Integration test job terjadwal terhadap Postgres test + Redis nyata.
// Dilewati bila salah satunya tidak menyala (docker compose up -d postgres-test redis).
//
// Yang dikunci di sini adalah sifat yang tidak bisa dibuktikan unit test:
// - unique expression index membuat ringkasan harian tidak pernah dobel walau dua job paralel;
// - compare-and-set alert_sent_at membuat peringatan anggaran hanya satu walau dua pemindaian
//   berjalan bersamaan;
// - enqueue gagal mengembalikan status notifikasi dan alert_sent_at ke keadaan yang bisa dicoba;
// - renew-budgets hanya membuat periode berjalan, menyalin kategori yang masih terlihat, dan
//   menulis audit actor_type 'system'.
//
// Tidak ada WhatsApp sungguhan: job hanya menulis ke antrean outbound; worker outbound tidak
// dijalankan di file ini.

import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { BudgetScanResult, RenewResult } from '../../src/modules/budgets/budgets.types.js';
import type { DailySummaryRunResult } from '../../src/modules/notifications/notifications.types.js';
import { createOutboundQueue } from '../../src/queues/outbound.queue.js';
import { createScheduledQueue, registerScheduledJobs, SCHEDULES } from '../../src/queues/scheduled.queue.js';
import { addDays, jakartaDayStartUtc, monthBounds, todayInJakarta } from '../../src/shared/utils/timezone.js';
import { createScheduledJobs, type ScheduledEnqueue } from '../../src/workers/scheduled.js';
import { createTestPrisma, ensureSystemCategories, resetUserData } from '../helpers/testDb.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const testDbUrl = inject('testDbUrl');
const testRedisUrl = inject('testRedisUrl');

// Tanggal WIB nyata: created_at notifikasi memakai jam database, jadi job test harus berjalan
// pada hari yang sama agar batas tiga pesan/hari ikut teruji. Jam 12.00 WIB selalu di dalam
// jendela 07.00-22.00 untuk budget-alert.
const today = todayInJakarta();
const NOON_WIB = new Date(jakartaDayStartUtc(today).getTime() + 12 * 60 * 60 * 1000);
const LATER_WIB = new Date(NOON_WIB.getTime() + 15 * 60 * 1000);
const currentMonth = monthBounds(today.slice(0, 7));

const asDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

interface SeededUser {
  userId: string;
  accountId: string;
  food: { id: string; name: string };
  transport: { id: string; name: string };
}

describe.skipIf(!testDbUrl || !testRedisUrl)('job terjadwal (integrasi, Postgres + Redis)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: ReturnType<typeof createOutboundQueue>;
  let prefix: string;

  beforeAll(async () => {
    prisma = createTestPrisma(testDbUrl);
    await ensureSystemCategories(prisma);
    redis = new Redis(testRedisUrl, { maxRetriesPerRequest: null });
    prefix = `test-scheduled-${randomUUID()}`;
    queue = createOutboundQueue(redis, { prefix });
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await prisma.auditLog.deleteMany();
    await resetUserData(prisma);
    await ensureSystemCategories(prisma);
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany();
    await resetUserData(prisma);
  });

  function jobs(enqueue?: ScheduledEnqueue) {
    return createScheduledJobs({
      prisma,
      outbound: queue,
      rng: () => 0,
      ...(enqueue ? { enqueue } : {}),
    });
  }

  async function seedUser(
    options: { dailySummaryEnabled?: boolean; budgetAlertEnabled?: boolean } = {},
  ): Promise<SeededUser> {
    const id = randomUUID();
    const digits = id.replace(/\D/g, '').padStart(12, '0').slice(0, 12);
    const categories = await prisma.category.findMany({
      where: { userId: null, type: 'expense' },
      orderBy: { sortOrder: 'asc' },
      take: 2,
    });
    const [food, transport] = categories;
    if (!food || !transport) throw new Error('Kategori sistem untuk test tidak lengkap');

    await prisma.$executeRaw`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${`scheduled-${id}@example.com`})`;
    await prisma.user.create({ data: { id, fullName: 'Scheduled Test' } });
    const account = await prisma.account.create({
      data: { userId: id, name: 'Dompet', type: 'cash', isDefault: true },
    });
    await prisma.whatsappAccount.create({
      data: {
        userId: id,
        phoneE164: `+62${digits}`,
        waChatId: `62${digits}@c.us`,
        status: 'verified',
        verifiedAt: NOON_WIB,
        dailySummaryEnabled: options.dailySummaryEnabled ?? false,
        budgetAlertEnabled: options.budgetAlertEnabled ?? false,
      },
    });

    return {
      userId: id,
      accountId: account.id,
      food: { id: food.id, name: food.name },
      transport: { id: transport.id, name: transport.name },
    };
  }

  async function addExpense(user: SeededUser, categoryId: string, amount: number): Promise<void> {
    await prisma.transaction.create({
      data: {
        userId: user.userId,
        accountId: user.accountId,
        categoryId,
        type: 'expense',
        amount,
        occurredAt: new Date(`${today}T05:00:00+07:00`),
        source: 'manual',
      },
    });
  }

  async function createMonthlyBudget(
    user: SeededUser,
    allocations: Array<{ categoryId: string; amount: number; alertThreshold: number }>,
  ) {
    return prisma.budget.create({
      data: {
        userId: user.userId,
        name: 'Anggaran berjalan',
        periodType: 'monthly',
        periodStart: asDate(currentMonth.from),
        periodEnd: asDate(currentMonth.to),
        totalAmount: allocations.reduce((sum, row) => sum + row.amount, 0),
        autoRenew: true,
        budgetCategories: { create: allocations },
      },
      include: { budgetCategories: true },
    });
  }

  it('mendaftarkan tiga job scheduler nyata di Redis', async () => {
    const scheduledQueue = createScheduledQueue(redis, { prefix });
    try {
      await registerScheduledJobs(scheduledQueue);
      const schedulers = await scheduledQueue.getJobSchedulers();
      expect(schedulers.map((scheduler) => scheduler.name).sort()).toEqual([
        'budget-alert',
        'daily-summary',
        'renew-budgets',
      ]);
      const daily = schedulers.find((scheduler) => scheduler.name === 'daily-summary');
      expect(daily).toMatchObject({ pattern: SCHEDULES.dailySummary.pattern, tz: SCHEDULES.dailySummary.tz });
    } finally {
      for (const scheduler of await scheduledQueue.getJobSchedulers()) {
        await scheduledQueue.removeJobScheduler(scheduler.key);
      }
      await scheduledQueue.obliterate({ force: true });
      await scheduledQueue.close();
    }
  });

  it('daily-summary dua kali paralel tetap satu notifikasi dan satu job', async () => {
    const user = await seedUser({ dailySummaryEnabled: true });
    await addExpense(user, user.food.id, 120_000);
    const handler = jobs().handlers['daily-summary'];

    const results = (await Promise.all([handler(NOON_WIB), handler(NOON_WIB)])) as DailySummaryRunResult[];
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);

    const rows = await prisma.notification.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'daily_summary',
      channel: 'whatsapp',
      status: 'pending',
      payload: { date: today },
    });

    const job = await queue.getJob(`daily:${user.userId}:${today}`);
    expect(job).not.toBeNull();
    expect(job?.data.notification_id).toBe(rows[0]!.id);
    expect(job?.data.wa_chat_id).toBe(`62${user.userId.replace(/\D/g, '').padStart(12, '0').slice(0, 12)}@c.us`);

    // Dijalankan lagi setelah baris ada: tidak boleh menambah notifikasi/job.
    const third = (await handler(NOON_WIB)) as DailySummaryRunResult;
    expect(third).toEqual({ targeted: 1, sent: 0, skipped: 1 });
    expect(await prisma.notification.count({ where: { userId: user.userId } })).toBe(1);
    expect(await queue.getJob(`daily:${user.userId}:${today}`)).not.toBeNull();
  });

  it('budget-alert dua kali paralel menghasilkan tepat satu notifikasi', async () => {
    const user = await seedUser({ budgetAlertEnabled: true });
    await addExpense(user, user.food.id, 80_000);
    const budget = await createMonthlyBudget(user, [
      { categoryId: user.food.id, amount: 100_000, alertThreshold: 80 },
    ]);
    const row = budget.budgetCategories[0]!;
    const handler = jobs().handlers['budget-alert'];

    const results = (await Promise.all([handler(NOON_WIB), handler(NOON_WIB)])) as BudgetScanResult[];
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);

    const rows = await prisma.notification.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'budget_alert',
      channel: 'whatsapp',
      status: 'pending',
      payload: { budget_id: budget.id, category_id: user.food.id },
    });

    const updated = await prisma.budgetCategory.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.alertSentAt).not.toBeNull();

    const job = await queue.getJob(`alert:${row.id}:${currentMonth.from}`);
    expect(job).not.toBeNull();
    expect(job?.data.notification_id).toBe(rows[0]!.id);
  });

  it('enqueue gagal menandai notifikasi failed dan mengembalikan alert_sent_at', async () => {
    const user = await seedUser({ budgetAlertEnabled: true });
    await addExpense(user, user.food.id, 80_000);
    const budget = await createMonthlyBudget(user, [
      { categoryId: user.food.id, amount: 100_000, alertThreshold: 80 },
    ]);
    const row = budget.budgetCategories[0]!;

    const failing = jobs(async () => {
      throw new Error('redis mati');
    });
    const first = (await failing.handlers['budget-alert'](NOON_WIB)) as BudgetScanResult;
    expect(first).toEqual({ sent: 0, skipped: 1 });

    const failed = await prisma.notification.findMany({ where: { userId: user.userId } });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe('failed');
    expect((await prisma.budgetCategory.findUniqueOrThrow({ where: { id: row.id } })).alertSentAt).toBeNull();

    // Pemindaian berikutnya boleh mencoba lagi karena alert_sent_at sudah NULL dan baris failed
    // tidak dihitung sebagai pesan yang masih mungkin terkirim.
    const retry = (await jobs().handlers['budget-alert'](LATER_WIB)) as BudgetScanResult;
    expect(retry).toEqual({ sent: 1, skipped: 0 });

    const all = await prisma.notification.findMany({ where: { userId: user.userId }, orderBy: { createdAt: 'asc' } });
    expect(all).toHaveLength(2);
    expect(all.filter((notification) => notification.status === 'pending')).toHaveLength(1);
    expect((await prisma.budgetCategory.findUniqueOrThrow({ where: { id: row.id } })).alertSentAt).not.toBeNull();
    expect(await queue.getJob(`alert:${row.id}:${currentMonth.from}`)).not.toBeNull();
  });

  it('renew-budgets idempoten, hanya periode berjalan, dan menulis audit system', async () => {
    const user = await seedUser();
    const hidden = await prisma.category.create({
      data: {
        userId: user.userId,
        name: 'Sembunyi',
        slug: `sembunyi-${randomUUID().slice(0, 8)}`,
        type: 'expense',
        icon: 'x',
        color: '#123456',
        keywords: [],
        deletedAt: NOON_WIB,
      },
    });
    const previousEnd = addDays(currentMonth.from, -1);
    const previousStart = addDays(previousEnd, -20);
    const old = await prisma.budget.create({
      data: {
        userId: user.userId,
        name: 'Anggaran lama',
        periodType: 'monthly',
        periodStart: asDate(previousStart),
        periodEnd: asDate(previousEnd),
        totalAmount: 300_000,
        autoRenew: true,
        rolloverEnabled: true,
        budgetCategories: {
          create: [
            { categoryId: user.food.id, amount: 100_000, alertThreshold: 80 },
            { categoryId: hidden.id, amount: 200_000, alertThreshold: 100 },
          ],
        },
      },
    });

    const handler = jobs().handlers['renew-budgets'];
    const first = (await handler(NOON_WIB)) as RenewResult;
    expect(first).toEqual({ created: 1, skipped: 0 });

    const renewed = await prisma.budget.findMany({
      where: {
        userId: user.userId,
        periodType: 'monthly',
        periodStart: asDate(currentMonth.from),
        deletedAt: null,
      },
      include: { budgetCategories: true },
    });
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatchObject({
      name: old.name,
      totalAmount: old.totalAmount,
      autoRenew: true,
      rolloverEnabled: true,
      periodEnd: asDate(currentMonth.to),
    });
    expect(renewed[0]!.budgetCategories.map((row) => row.categoryId)).toEqual([user.food.id]);
    expect(renewed[0]!.budgetCategories[0]).toMatchObject({ amount: 100_000, alertThreshold: 80, alertSentAt: null });

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'budget', entityId: renewed[0]!.id, action: 'create' },
    });
    expect(audit?.actorType).toBe('system');
    expect(audit?.ipAddress).toBeNull();

    // Dijalankan lagi: periode berjalan sudah ada, jadi tidak membuat periode baru atau
    // mengisi periode yang terlewat.
    const second = (await handler(NOON_WIB)) as RenewResult;
    expect(second).toEqual({ created: 0, skipped: 1 });
    expect(await prisma.budget.count({ where: { userId: user.userId, deletedAt: null } })).toBe(2);
  });
});
