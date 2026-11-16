// Aturan job terjadwal di service notifications, tanpa database/Redis.
// SQL idempotensi (unique expression index, compare-and-set) diuji di
// tests/integration/scheduled.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  createNotificationsService,
  DAILY_SUMMARY_DELAY_MAX_MS,
  dailySummaryDelayMs,
} from '../../src/modules/notifications/notifications.service.js';
import type {
  BudgetAlertClaimStore,
  BudgetAlertDelivery,
  DailySummaryAudience,
  DailySummaryReader,
  NotificationsRepository,
  NotificationsScheduledStore,
  ScheduledAccountCandidate,
  ScheduledMessage,
} from '../../src/modules/notifications/notifications.types.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const OTHER_USER = '8e2b1a0d-5a3c-4d7b-8b0e-9c4d6f7a1b2c';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTIF_ID = '11111111-1111-4111-8111-111111111111';
const BUDGET_ID = '22222222-2222-4222-8222-222222222222';
const BUDGET_CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
const CATEGORY_ID = '44444444-4444-4444-8444-444444444444';
const WA = '628123456789@c.us';

// 2026-11-12 20.00 WIB; 23.59 WIB masih tanggal 12, 00.00 WIB sudah tanggal 13.
const NOW_2000 = new Date('2026-11-12T13:00:00.000Z');
const NOW_2359 = new Date('2026-11-12T16:59:00.000Z');
const NOW_0000 = new Date('2026-11-12T17:00:00.000Z');

function account(overrides: Partial<ScheduledAccountCandidate> = {}): ScheduledAccountCandidate {
  return {
    accountId: ACCOUNT,
    userId: USER,
    waChatId: WA,
    status: 'verified',
    dailySummaryEnabled: true,
    budgetAlertEnabled: true,
    userDeletedAt: null,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<NotificationsRepository> = {}): NotificationsRepository {
  return {
    createPending: vi.fn(async () => ({ id: NOTIF_ID })),
    list: vi.fn(async () => []),
    markRead: vi.fn(async () => ({ status: 'not_found' as const })),
    markSent: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<NotificationsScheduledStore> = {}): NotificationsScheduledStore {
  return {
    findDailySummary: vi.fn(async () => null),
    createDailySummary: vi.fn(async () => ({ status: 'created' as const, id: NOTIF_ID })),
    countAutomaticOnDate: vi.fn(async () => 0),
    ...overrides,
  };
}

function fakeClaimStore(overrides: Partial<BudgetAlertClaimStore> = {}): BudgetAlertClaimStore {
  return {
    claim: vi.fn(async () => ({ status: 'created' as const, notificationId: NOTIF_ID })),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeAudience(rows: ScheduledAccountCandidate[]): DailySummaryAudience {
  return {
    list: vi.fn(async (afterAccountId: string | null, limit: number) => {
      const start = afterAccountId ? rows.findIndex((row) => row.accountId === afterAccountId) + 1 : 0;
      return rows.slice(start, start + limit);
    }),
  };
}

function fakeSummary(): DailySummaryReader {
  return {
    dailyStats: vi.fn(async () => ({
      income: 500_000,
      expense: 120_000,
      topExpenseCategory: { name: 'Makanan', total: 120_000 },
    })),
  };
}

function arranged(overrides: {
  repository?: NotificationsRepository;
  store?: NotificationsScheduledStore;
  claim?: BudgetAlertClaimStore;
  audience?: DailySummaryAudience;
  summary?: DailySummaryReader;
  sender?: (message: ScheduledMessage) => Promise<void>;
  rng?: () => number;
} = {}) {
  const repository = overrides.repository ?? fakeRepository();
  const store = overrides.store ?? fakeStore();
  const claim = overrides.claim ?? fakeClaimStore();
  const audience = overrides.audience ?? fakeAudience([account()]);
  const summary = overrides.summary ?? fakeSummary();
  const sender = overrides.sender ?? vi.fn(async () => undefined);
  const service = createNotificationsService(repository, {
    store,
    budgetAlerts: claim,
    audience,
    summary,
    sender,
    rng: overrides.rng ?? (() => 0),
  });
  return { service, repository, store, claim, audience, summary, sender };
}

describe('dailySummaryDelayMs', () => {
  it('berada di 0 sampai 30 menit, inklusif', () => {
    expect(dailySummaryDelayMs(() => 0)).toBe(0);
    expect(dailySummaryDelayMs(() => 0.5)).toBe(Math.floor(DAILY_SUMMARY_DELAY_MAX_MS / 2));
    expect(dailySummaryDelayMs(() => 0.999999999)).toBeLessThanOrEqual(DAILY_SUMMARY_DELAY_MAX_MS);
  });
});

describe('runDailySummary', () => {
  it('pada 20.00 WIB membuat satu notifikasi dan jobId deterministik', async () => {
    const { service, store, sender } = arranged();

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 1, sent: 1, skipped: 0 });
    expect(store.createDailySummary).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ date: '2026-11-12', title: expect.any(String), body: expect.any(String) }),
    );
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        waChatId: WA,
        notificationId: NOTIF_ID,
        jobId: `daily:${USER}:2026-11-12`,
        delayMs: 0,
      }),
    );
  });

  it('menggunakan tanggal WIB yang benar di 23.59 dan 00.00', async () => {
    const first = arranged();
    await first.service.runDailySummary(NOW_2359);
    expect(first.store.createDailySummary).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ date: '2026-11-12' }),
    );

    const second = arranged();
    await second.service.runDailySummary(NOW_0000);
    expect(second.store.createDailySummary).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ date: '2026-11-13' }),
    );
  });

  it('menerapkan jitter 0-30 menit pada scheduled_for dan job', async () => {
    const { service, store, sender } = arranged({ rng: () => 0.999999999 });

    await service.runDailySummary(NOW_2000);

    expect(store.createDailySummary).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        scheduledFor: new Date(NOW_2000.getTime() + DAILY_SUMMARY_DELAY_MAX_MS),
      }),
    );
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: DAILY_SUMMARY_DELAY_MAX_MS }),
    );
  });

  it.each([
    ['sakelar mati', account({ dailySummaryEnabled: false })],
    ['akun belum verified', account({ status: 'pending' })],
    ['pengguna soft-delete', account({ userDeletedAt: new Date('2026-11-01T00:00:00Z') })],
  ])('melewati akun: %s', async (_label, row) => {
    const { service, store, sender } = arranged({ audience: fakeAudience([row]) });

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 0, sent: 0, skipped: 1 });
    expect(store.createDailySummary).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it('melewati pengguna tanpa transaksi pada hari itu', async () => {
    const summary: DailySummaryReader = {
      dailyStats: vi.fn(async () => ({ income: 0, expense: 0, topExpenseCategory: null })),
    };
    const { service, store } = arranged({ summary });

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 1, sent: 0, skipped: 1 });
    expect(store.createDailySummary).not.toHaveBeenCalled();
  });

  it('tidak membuat baris kedua bila ringkasan hari itu sudah ada', async () => {
    const store = fakeStore({ findDailySummary: vi.fn(async () => ({ id: NOTIF_ID })) });
    const { service, sender } = arranged({ store });

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 1, sent: 0, skipped: 1 });
    expect(store.createDailySummary).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it('berhenti membuat pesan setelah tiga notifikasi otomatis hari itu', async () => {
    const store = fakeStore({ countAutomaticOnDate: vi.fn(async () => 3) });
    const { service, sender } = arranged({ store });

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 1, sent: 0, skipped: 1 });
    expect(store.findDailySummary).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it('menandai notifikasi failed bila enqueue outbound gagal', async () => {
    const sender = vi.fn(async () => {
      throw new Error('redis mati');
    });
    const { service, repository } = arranged({ sender });

    const result = await service.runDailySummary(NOW_2000);

    expect(result).toEqual({ targeted: 1, sent: 0, skipped: 1 });
    expect(repository.markFailed).toHaveBeenCalledWith(NOTIF_ID);
  });

  it('memproses akun pada halaman berikutnya', async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      account({
        accountId:
          index === 50
            ? OTHER_ACCOUNT
            : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        userId: index === 50 ? OTHER_USER : USER,
        waChatId: index === 50 ? '628999999999@c.us' : WA,
      }),
    );
    const { service, audience } = arranged({ audience: fakeAudience(rows) });

    await service.runDailySummary(NOW_2000);

    expect(audience.list).toHaveBeenCalledTimes(2);
    expect(audience.list).toHaveBeenLastCalledWith(rows[49]!.accountId, 50);
  });
});

describe('deliverBudgetAlert', () => {
  const notice = (overrides: Partial<BudgetAlertDelivery> = {}): BudgetAlertDelivery => ({
    userId: USER,
    waChatId: WA,
    budgetId: BUDGET_ID,
    budgetCategoryId: BUDGET_CATEGORY_ID,
    categoryId: CATEGORY_ID,
    budgetName: 'November',
    categoryName: 'Makanan',
    spent: 80_000,
    amount: 100_000,
    periodStart: '2026-11-01',
    now: NOW_2000,
    ...overrides,
  });

  it('mengklaim, membuat notifikasi, lalu memakai jobId per kategori/periode', async () => {
    const { service, claim, sender } = arranged();

    const result = await service.deliverBudgetAlert(notice());

    expect(result).toBe('sent');
    expect(claim.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        budgetId: BUDGET_ID,
        budgetCategoryId: BUDGET_CATEGORY_ID,
        categoryId: CATEGORY_ID,
        now: NOW_2000,
        payload: { budget_id: BUDGET_ID, category_id: CATEGORY_ID },
      }),
    );
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: NOTIF_ID,
        jobId: `alert:${BUDGET_CATEGORY_ID}:2026-11-01`,
      }),
    );
  });

  it('tidak mengirim bila kategori sudah pernah diklaim', async () => {
    const claim = fakeClaimStore({ claim: vi.fn(async () => ({ status: 'already_sent' as const })) });
    const { service, sender } = arranged({ claim });

    const result = await service.deliverBudgetAlert(notice());

    expect(result).toBe('skipped');
    expect(sender).not.toHaveBeenCalled();
  });

  it('tidak mengklaim bila batas tiga pesan otomatis sudah penuh', async () => {
    const store = fakeStore({ countAutomaticOnDate: vi.fn(async () => 3) });
    const { service, claim } = arranged({ store });

    const result = await service.deliverBudgetAlert(notice());

    expect(result).toBe('skipped');
    expect(claim.claim).not.toHaveBeenCalled();
  });

  it('mengembalikan alert_sent_at bila enqueue outbound gagal', async () => {
    const sender = vi.fn(async () => {
      throw new Error('redis mati');
    });
    const { service, claim } = arranged({ sender });

    const result = await service.deliverBudgetAlert(notice());

    expect(result).toBe('skipped');
    expect(claim.release).toHaveBeenCalledWith({
      userId: USER,
      budgetId: BUDGET_ID,
      budgetCategoryId: BUDGET_CATEGORY_ID,
      categoryId: CATEGORY_ID,
      notificationId: NOTIF_ID,
      claimedAt: NOW_2000,
    });
  });
});
