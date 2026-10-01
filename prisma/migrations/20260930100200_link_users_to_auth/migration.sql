-- Migrasi 3: users.id menjadi FK ke auth.users(id) milik Supabase.
-- Skema `auth` sengaja tidak dipetakan di schema.prisma (BACKEND-STRUCTURE 4.4),
-- jadi Prisma tidak tahu constraint ini dan tidak perlu tahu.
--
-- Dibungkus penjaga: shadow database milik `prisma migrate dev` tidak punya skema
-- `auth`. Tanpa penjaga, setiap migrate dev berikutnya gagal di sini. Di Supabase
-- skemanya selalu ada, sehingga constraint tetap terpasang.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'users_id_fkey' AND conrelid = 'public.users'::regclass
     )
  THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_id_fkey"
      FOREIGN KEY ("id") REFERENCES auth.users ("id") ON DELETE CASCADE;
  END IF;
END
$$;
