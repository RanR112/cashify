-- Migrasi 4: Row Level Security untuk semua tabel.
--
-- Cara membaca ini. Prisma terhubung sebagai role `postgres`, pemilik tabel, dan
-- melewati RLS. Jadi RLS BUKAN pertahanan untuk API Express (itu filter user_id
-- di repository). RLS melindungi jalur kedua: klien Supabase (Realtime) yang
-- memakai anon key dan JWT pengguna.
--
-- Prinsip hak minimum:
--  * `authenticated` hanya boleh SELECT baris miliknya. Semua penulisan lewat backend.
--  * Tabel yang berisi data sensitif atau internal diaktifkan RLS TANPA policy,
--    artinya ditolak untuk semua role klien: whatsapp_verifications (code_hash),
--    message_logs (raw_payload), audit_logs, whatsapp_sessions.
--  * FORCE ROW LEVEL SECURITY tidak dipakai; backend memang harus melewati RLS.
--
-- ENABLE ROW LEVEL SECURITY valid di PostgreSQL biasa. Pembuatan policy
-- bergantung pada auth.uid() dan role `authenticated` milik Supabase, sehingga
-- dibungkus penjaga agar shadow database Prisma tidak gagal.

ALTER TABLE "users"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_accounts"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_sessions"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budgets"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_categories"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_logs"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"             ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
  ) THEN
    RAISE NOTICE 'Skema auth atau role authenticated tidak ada (bukan Supabase); policy RLS dilewati.';
    RETURN;
  END IF;

  -- `(SELECT auth.uid())` dievaluasi sekali per kueri, bukan sekali per baris.
  CREATE POLICY "users_select_own" ON "users"
    FOR SELECT TO authenticated
    USING ("id" = (SELECT auth.uid()));

  CREATE POLICY "whatsapp_accounts_select_own" ON "whatsapp_accounts"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));

  CREATE POLICY "accounts_select_own" ON "accounts"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));

  -- Kategori sistem (user_id NULL) terlihat oleh semua pengguna.
  CREATE POLICY "categories_select_own_or_system" ON "categories"
    FOR SELECT TO authenticated
    USING ("user_id" IS NULL OR "user_id" = (SELECT auth.uid()));

  CREATE POLICY "transactions_select_own" ON "transactions"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));

  CREATE POLICY "budgets_select_own" ON "budgets"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));

  -- budget_categories tidak punya user_id; kepemilikan lewat budgets.
  CREATE POLICY "budget_categories_select_own" ON "budget_categories"
    FOR SELECT TO authenticated
    USING (EXISTS (
      SELECT 1 FROM "budgets" b
      WHERE b."id" = "budget_categories"."budget_id"
        AND b."user_id" = (SELECT auth.uid())
    ));

  CREATE POLICY "recurring_transactions_select_own" ON "recurring_transactions"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));

  CREATE POLICY "notifications_select_own" ON "notifications"
    FOR SELECT TO authenticated
    USING ("user_id" = (SELECT auth.uid()));
END
$$;
