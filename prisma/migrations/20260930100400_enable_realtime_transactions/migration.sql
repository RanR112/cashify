-- Migrasi 5: Supabase Realtime untuk transactions.
--
-- Realtime hanya mengirim perubahan tabel yang terdaftar di publication
-- `supabase_realtime`, dan Prisma tidak tahu soal itu. Tanpa migrasi ini
-- sinkronisasi (ARCHITECTURE.md Bagian 14) tidak berjalan dan tidak ada error;
-- datanya hanya tidak pernah sampai. Dikerjakan sekarang walau belum ada klien
-- Realtime, karena menambahkannya nanti berarti migrasi di database berisi data.

-- REPLICA IDENTITY FULL: payload event memuat nilai lama, dibutuhkan untuk
-- membedakan UPDATE biasa dari soft delete (deleted_at berubah dari NULL).
ALTER TABLE "transactions" REPLICA IDENTITY FULL;

-- Publication hanya ada di Supabase; dilewati di shadow database Prisma.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'transactions'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "transactions";
  END IF;
END
$$;
