import { AppError } from '../../shared/errors/AppError.js';
import { jakartaHour, monthBounds, todayInJakarta, weekBounds } from '../../shared/utils/timezone.js';
import type {
  AuditContext,
  BudgetAlertNotice,
  BudgetDetailBody,
  BudgetListBody,
  BudgetListQuery,
  BudgetPatch,
  BudgetPeriodType,
  BudgetRecord,
  BudgetScanResult,
  BudgetStatus,
  BudgetSummaryBody,
  BudgetsRepository,
  BudgetsScheduledDeps,
  CategoryAllocation,
  CreateBudgetInput,
  RenewResult,
  SpendingReader,
  UpdateBudgetInput,
  VisibleCategory,
} from './budgets.types.js';

const toDateString = (date: Date): string => date.toISOString().slice(0, 10);
/** Halaman akun untuk pemindaian alert; kecil agar tidak menahan semua pengguna di memori. */
const SCHEDULED_PAGE_SIZE = 50;

/** Persen satu desimal; pembagian nol menghasilkan 0 (bukan NaN). */
function percentOf(spent: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round((spent / limit) * 1000) / 10;
}

/** `ok` < ambang, `warning` ambang..100, `over` > 100. */
function statusOf(percent: number, threshold: number): BudgetStatus {
  if (percent < threshold) return 'ok';
  return percent <= 100 ? 'warning' : 'over';
}

/** `period_end` dihitung server; `period_start` dinormalkan ke awal periode. */
function periodOf(type: BudgetPeriodType, start: string): { start: string; end: string } {
  if (type === 'monthly') {
    const { from, to } = monthBounds(start.slice(0, 7));
    return { start: from, end: to };
  }
  const { from, to } = weekBounds(start);
  return { start: from, end: to };
}

function toBudgetBody(record: BudgetRecord) {
  return {
    id: record.id,
    name: record.name,
    period_type: record.periodType as BudgetPeriodType,
    period_start: toDateString(record.periodStart),
    period_end: toDateString(record.periodEnd),
    total_amount: record.totalAmount,
    auto_renew: record.autoRenew,
    rollover_enabled: record.rolloverEnabled,
    categories: record.budgetCategories.map((category) => ({
      category_id: category.categoryId,
      name: category.category.name,
      slug: category.category.slug,
      amount: category.amount,
      alert_threshold: category.alertThreshold,
    })),
    created_at: record.createdAt.toISOString(),
  };
}

const OVERLAP_MESSAGE = 'Periode anggaran beririsan dengan anggaran lain';

export interface BudgetsServiceDeps {
  repository: BudgetsRepository;
  spending: SpendingReader;
  /** Bisa disuntik untuk test; menentukan "hari ini" WIB dan anggaran aktif. */
  now?: () => Date;
  /** Port job `budget-alert`; tanpa ini hanya endpoint HTTP yang tersedia. */
  alerts?: BudgetsScheduledDeps;
}

export function createBudgetsService({ repository, spending, now = () => new Date(), alerts }: BudgetsServiceDeps) {
  const today = (): string => todayInJakarta(now());

  function requireAlerts(): BudgetsScheduledDeps {
    if (!alerts) throw new Error('Job budget-alert belum dirakit');
    return alerts;
  }

  async function ensureVisibleExpenseCategories(userId: string, categories: CategoryAllocation[]): Promise<void> {
    const visible = await repository.findVisibleCategories(
      userId,
      categories.map((category) => category.categoryId),
    );
    const byId = new Map<string, VisibleCategory>(visible.map((category) => [category.id, category]));

    for (const category of categories) {
      const found = byId.get(category.categoryId);
      if (!found) throw AppError.notFound('Kategori tidak ditemukan');
      if (found.type !== 'expense') {
        throw AppError.validation('Kategori anggaran harus bertipe pengeluaran', [
          { field: 'category_id', issue: 'type_mismatch' },
        ]);
      }
    }
  }

  async function ensureNoOverlap(
    userId: string,
    periodStart: string,
    periodEnd: string,
    excludeId?: string,
  ): Promise<void> {
    const overlapping = await repository.findOverlapping(userId, periodStart, periodEnd, excludeId);
    if (overlapping) {
      throw AppError.conflict(OVERLAP_MESSAGE, [{ field: 'period_start', issue: 'overlap' }]);
    }
  }

  async function detailOf(userId: string, record: BudgetRecord): Promise<BudgetDetailBody> {
    const spent = await spending.spendingInRange(userId, {
      from: toDateString(record.periodStart),
      to: toDateString(record.periodEnd),
    });

    const percentTotal = percentOf(spent.total, record.totalAmount);

    return {
      ...toBudgetBody(record),
      spent_total: spent.total,
      remaining_total: record.totalAmount - spent.total,
      percent_total: percentTotal,
      status_total: statusOf(percentTotal, 80),
      categories: record.budgetCategories.map((category) => {
        const categorySpent = spent.byCategory[category.categoryId] ?? 0;
        const percent = percentOf(categorySpent, category.amount);
        return {
          category_id: category.categoryId,
          name: category.category.name,
          slug: category.category.slug,
          amount: category.amount,
          alert_threshold: category.alertThreshold,
          spent: categorySpent,
          remaining: category.amount - categorySpent,
          percent,
          status: statusOf(percent, category.alertThreshold),
        };
      }),
    };
  }

  return {
    async list(userId: string, query: BudgetListQuery): Promise<BudgetListBody> {
      const records = await repository.list(userId, query.status, today());
      return { data: records.map(toBudgetBody) };
    },

    async current(userId: string): Promise<BudgetDetailBody> {
      const record = await repository.findActive(userId, today());
      if (!record) throw AppError.notFound('Anggaran aktif tidak ditemukan');
      return detailOf(userId, record);
    },

    async get(userId: string, id: string): Promise<BudgetDetailBody> {
      const record = await repository.findById(userId, id);
      if (!record) throw AppError.notFound('Anggaran tidak ditemukan');
      return detailOf(userId, record);
    },

    async create(userId: string, input: CreateBudgetInput, audit: AuditContext) {
      const period = periodOf(input.period_type, input.period_start);
      const categories: CategoryAllocation[] = input.categories.map((category) => ({
        categoryId: category.category_id,
        amount: category.amount,
        alertThreshold: category.alert_threshold,
      }));

      await ensureVisibleExpenseCategories(userId, categories);
      await ensureNoOverlap(userId, period.start, period.end);

      const outcome = await repository.create(
        userId,
        {
          name: input.name ?? null,
          periodType: input.period_type,
          periodStart: period.start,
          periodEnd: period.end,
          totalAmount: input.total_amount,
          autoRenew: input.auto_renew,
          rolloverEnabled: input.rollover_enabled,
          categories,
        },
        audit,
      );

      if (outcome.status === 'conflict') {
        throw AppError.conflict(OVERLAP_MESSAGE, [{ field: 'period_start', issue: 'overlap' }]);
      }
      return toBudgetBody(outcome.record);
    },

    async update(userId: string, id: string, input: UpdateBudgetInput, audit: AuditContext) {
      const existing = await repository.findById(userId, id);
      if (!existing) throw AppError.notFound('Anggaran tidak ditemukan');

      const patch: BudgetPatch = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.total_amount !== undefined && { totalAmount: input.total_amount }),
        ...(input.auto_renew !== undefined && { autoRenew: input.auto_renew }),
        ...(input.rollover_enabled !== undefined && { rolloverEnabled: input.rollover_enabled }),
      };

      let allocations: CategoryAllocation[] | undefined;
      if (input.categories) {
        const current = new Map(existing.budgetCategories.map((category) => [category.categoryId, category]));
        allocations = input.categories.map((category) => ({
          categoryId: category.category_id,
          amount: category.amount,
          // Tidak dikirim berarti tidak berubah; baris baru memakai bawaan 80.
          alertThreshold:
            category.alert_threshold ?? current.get(category.category_id)?.alertThreshold ?? 80,
        }));
        await ensureVisibleExpenseCategories(userId, allocations);
        patch.categories = allocations;
      }

      const totalAmount = patch.totalAmount ?? existing.totalAmount;
      const finalAllocations =
        allocations ??
        existing.budgetCategories.map((category) => ({
          categoryId: category.categoryId,
          amount: category.amount,
          alertThreshold: category.alertThreshold,
        }));
      const allocated = finalAllocations.reduce((sum, category) => sum + category.amount, 0);
      if (allocated > totalAmount) {
        throw AppError.validation('Jumlah alokasi kategori melebihi total anggaran', [
          { field: 'categories', issue: 'exceeds_total' },
        ]);
      }

      const outcome = await repository.update(userId, id, patch, audit);
      if (outcome.status === 'not_found') throw AppError.notFound('Anggaran tidak ditemukan');
      if (outcome.status === 'conflict') {
        throw AppError.conflict(OVERLAP_MESSAGE, [{ field: 'period_start', issue: 'overlap' }]);
      }
      return toBudgetBody(outcome.record);
    },

    async remove(userId: string, id: string, audit: AuditContext): Promise<void> {
      const deleted = await repository.softDelete(userId, id, audit);
      if (!deleted) throw AppError.notFound('Anggaran tidak ditemukan');
    },

    /** Ringkasan anggaran aktif untuk GET /dashboard; null bila tidak ada. */
    async summary(userId: string): Promise<BudgetSummaryBody | null> {
      const record = await repository.findActive(userId, today());
      if (!record) return null;

      const spent = await spending.spendingInRange(userId, {
        from: toDateString(record.periodStart),
        to: toDateString(record.periodEnd),
      });
      const percent = percentOf(spent.total, record.totalAmount);

      return {
        budget_id: record.id,
        name: record.name,
        period_start: toDateString(record.periodStart),
        period_end: toDateString(record.periodEnd),
        total: record.totalAmount,
        used: spent.total,
        remaining: record.totalAmount - spent.total,
        percent,
        status: statusOf(percent, 80),
      };
    },

    /**
     * Job `budget-alert`: pindai akun + anggaran aktif, lalu serahkan kategori yang melewati
     * ambang ke notifier. Tidak ada notifikasi yang dibuat di luar jendela 07.00-22.00 WIB
     * (PHASE2-DECISIONS §5.11) supaya `alert_sent_at` tidak terpakai untuk pesan yang tidak
     * akan terkirim pada jam istirahat.
     */
    async scanAlerts(now: Date): Promise<BudgetScanResult> {
      const deps = requireAlerts();
      const hour = jakartaHour(now);
      if (hour < 7 || hour >= 22) return { sent: 0, skipped: 0 };

      const day = todayInJakarta(now);
      let afterAccountId: string | null = null;
      let sent = 0;
      let skipped = 0;

      for (;;) {
        const page = await deps.audience.list(afterAccountId, SCHEDULED_PAGE_SIZE);
        if (page.length === 0) break;

        for (const account of page) {
          // Port hanya membaca; kelayakan tetap diputuskan di sini (mudah diuji tanpa DB).
          if (account.status !== 'verified' || !account.budgetAlertEnabled || account.userDeletedAt !== null) {
            skipped += 1;
            continue;
          }

          const budget = await repository.findActive(account.userId, day);
          if (!budget) {
            skipped += 1;
            continue;
          }

          const periodStart = toDateString(budget.periodStart);
          const periodEnd = toDateString(budget.periodEnd);
          const spent = await spending.spendingInRange(account.userId, { from: periodStart, to: periodEnd });

          for (const category of budget.budgetCategories) {
            if (category.alertSentAt !== null) {
              skipped += 1;
              continue;
            }

            const categorySpent = spent.byCategory[category.categoryId] ?? 0;
            // Perbandingan integer eksak, bukan persen yang sudah dibulatkan: 79.999/100.000
            // tidak boleh dianggap tepat 80% hanya karena tampilan satu desimal.
            if (categorySpent * 100 < category.amount * category.alertThreshold) continue;

            const notice: BudgetAlertNotice = {
              userId: account.userId,
              waChatId: account.waChatId,
              budgetId: budget.id,
              budgetCategoryId: category.id,
              categoryId: category.categoryId,
              budgetName: budget.name,
              categoryName: category.category.name,
              spent: categorySpent,
              amount: category.amount,
              periodStart,
              now,
            };

            const outcome = await deps.notifier.deliver(notice);
            if (outcome === 'sent') sent += 1;
            else skipped += 1;
          }
        }

        if (page.length < SCHEDULED_PAGE_SIZE) break;
        afterAccountId = page[page.length - 1]!.accountId;
      }

      return { sent, skipped };
    },

    /**
     * Job `renew-budgets`: hanya periode yang memuat hari ini, bukan semua periode yang
     * terlewat. Ambil satu anggaran terbaru per pengguna, lewati kategori yang sudah tidak
     * terlihat, lalu biarkan partial unique index menjadi penjaga idempotensi.
     */
    async renew(now: Date): Promise<RenewResult> {
      const day = todayInJakarta(now);
      const due = await repository.listDueRenewals(day);

      // listDueRenewals sudah urut periode terbaru per pengguna; ambil yang pertama saja.
      const latestByUser = new Map<string, BudgetRecord>();
      for (const budget of due) {
        if (!latestByUser.has(budget.userId)) latestByUser.set(budget.userId, budget);
      }

      let created = 0;
      let skipped = 0;

      for (const [userId, budget] of latestByUser) {
        const active = await repository.findActive(userId, day);
        if (active) {
          skipped += 1;
          continue;
        }

        if (budget.periodType !== 'monthly' && budget.periodType !== 'weekly') {
          skipped += 1;
          continue;
        }
        const periodType: BudgetPeriodType = budget.periodType;
        const period = periodOf(periodType, day);

        const visible = await repository.findVisibleCategories(
          userId,
          budget.budgetCategories.map((category) => category.categoryId),
        );
        const visibleIds = new Set(visible.map((category) => category.id));
        const categories: CategoryAllocation[] = budget.budgetCategories
          .filter((category) => visibleIds.has(category.categoryId))
          .map((category) => ({
            categoryId: category.categoryId,
            amount: category.amount,
            alertThreshold: category.alertThreshold,
          }));

        const outcome = await repository.createRenewal(userId, {
          name: budget.name,
          periodType,
          periodStart: period.start,
          periodEnd: period.end,
          totalAmount: budget.totalAmount,
          autoRenew: budget.autoRenew,
          // Disimpan agar preferensi pengguna tidak hilang; efek rollover tetap tidak ada.
          rolloverEnabled: budget.rolloverEnabled,
          categories,
        });

        if (outcome.status === 'created') created += 1;
        else skipped += 1;
      }

      return { created, skipped };
    },
  };
}

export type BudgetsService = ReturnType<typeof createBudgetsService>;
