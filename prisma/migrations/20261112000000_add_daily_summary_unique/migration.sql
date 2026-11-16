-- Migrasi 7: unique expression index untuk idempotensi ringkasan harian.
--
-- Index ini disetujui di claude/PHASE2-DECISIONS.md Q12: baris daily_summary untuk
-- (user_id, tanggal) harus unik, termasuk saat dua job/worker berjalan bersamaan.
-- Prisma tidak bisa mengekspresikan index pada ekspresi JSON, jadi migrasi ini ditulis
-- manual (pola yang sama dengan migrasi 6) dan diterapkan lewat `prisma migrate deploy`.
--
-- Rollback:
--   DROP INDEX "notifications_daily_summary_key";
-- lalu `prisma migrate resolve --rolled-back 20261112000000_add_daily_summary_unique`
-- (atau hapus folder migrasi bila database akan dibuat ulang).
--
-- Catatan: payload daily_summary selalu memuat `date` (YYYY-MM-DD). Baris dengan payload
-- NULL tidak masuk index parsial ini karena `payload->>'date'` bernilai NULL; unique index
-- PostgreSQL memperlakukan NULL sebagai nilai yang berbeda, tetapi kode selalu mengisi date.

CREATE UNIQUE INDEX "notifications_daily_summary_key"
  ON "notifications" ("user_id", "type", (("payload" ->> 'date')))
  WHERE "type" = 'daily_summary';
