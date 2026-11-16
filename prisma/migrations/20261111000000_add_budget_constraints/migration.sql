-- Migrasi 6: constraint anggaran yang tidak bisa diekspresikan schema.prisma
-- (partial unique index dan CHECK). Tabel masih kosong, jadi tidak ada backfill.
--
-- Rollback:
--   DROP INDEX "budgets_user_period_key";
--   ALTER TABLE "budget_categories" DROP CONSTRAINT "budget_categories_alert_threshold_check";
--   ALTER TABLE "budget_categories" DROP CONSTRAINT "budget_categories_amount_positive_check";
--   ALTER TABLE "budgets" DROP CONSTRAINT "budgets_period_range_check";
--   ALTER TABLE "budgets" DROP CONSTRAINT "budgets_total_amount_positive_check";
-- lalu `prisma migrate resolve --rolled-back 20261111000000_add_budget_constraints`
-- (atau hapus folder migrasi bila database akan dibuat ulang).
--
-- Catatan: `prisma migrate dev` tidak bisa dipakai di proyek ini karena FK
-- public.users -> auth.users (skema auth tidak dipetakan Prisma). Migrasi ini dibuat
-- manual dengan pola yang sama dan diterapkan lewat `prisma migrate deploy`.

-- Satu anggaran aktif per (user_id, period_type, period_start). Ini lapis kedua setelah
-- pemeriksaan irisan periode di service (Q3): baris soft-deleted membebaskan kunci.
CREATE UNIQUE INDEX "budgets_user_period_key"
  ON "budgets" ("user_id", "period_type", "period_start")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_total_amount_positive_check" CHECK ("total_amount" > 0);

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_period_range_check" CHECK ("period_end" >= "period_start");

ALTER TABLE "budget_categories"
  ADD CONSTRAINT "budget_categories_amount_positive_check" CHECK ("amount" > 0);

ALTER TABLE "budget_categories"
  ADD CONSTRAINT "budget_categories_alert_threshold_check" CHECK ("alert_threshold" BETWEEN 1 AND 100);
