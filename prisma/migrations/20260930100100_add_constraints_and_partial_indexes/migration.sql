-- Migrasi 2: semua yang diminta ARCHITECTURE.md Bagian 9 tetapi tidak bisa
-- diekspresikan di schema.prisma (CHECK dan partial index).
-- Prisma mengabaikan index parsial saat membandingkan skema, jadi migrate dev
-- berikutnya tidak akan mencoba menghapusnya.

-- transactions ---------------------------------------------------------------

-- Tipe ditentukan kolom `type`, bukan tanda nominal; nominal selalu positif.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_positive_check" CHECK ("amount" > 0);

-- Kueri riwayat: paling sering dijalankan.
CREATE INDEX "transactions_user_id_date_active_idx"
  ON "transactions" ("user_id", "date" DESC)
  WHERE "deleted_at" IS NULL;

-- Mencari "transaksi terakhir" untuk perintah koreksi dan hapus lewat WhatsApp.
CREATE INDEX "transactions_user_id_created_at_active_idx"
  ON "transactions" ("user_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;

-- whatsapp_accounts ----------------------------------------------------------

-- Dua akun tidak boleh memakai nomor yang sama.
CREATE UNIQUE INDEX "whatsapp_accounts_phone_e164_verified_key"
  ON "whatsapp_accounts" ("phone_e164")
  WHERE "status" = 'verified';

-- Dipakai mencari pengguna saat webhook masuk; harus cepat dan unik.
CREATE UNIQUE INDEX "whatsapp_accounts_wa_chat_id_verified_key"
  ON "whatsapp_accounts" ("wa_chat_id")
  WHERE "status" = 'verified';

-- Satu pengguna, satu tautan aktif (pending atau verified). Tautan yang diputus
-- (status = 'disabled') tetap tersimpan dan tidak menghalangi tautan baru.
-- Bagian 9 menulis "WHERE deleted_at IS NULL", tetapi tabel ini tidak punya
-- deleted_at; pemutusan bersifat soft lewat status (Bagian 11).
CREATE UNIQUE INDEX "whatsapp_accounts_user_id_active_key"
  ON "whatsapp_accounts" ("user_id")
  WHERE "status" <> 'disabled';

-- categories -----------------------------------------------------------------

-- UNIQUE (user_id, slug) tidak menangkap duplikat kategori sistem, karena
-- PostgreSQL menganggap setiap NULL berbeda. Index ini menutup celahnya dan
-- menjadi pengaman seed idempoten.
CREATE UNIQUE INDEX "categories_system_slug_key"
  ON "categories" ("slug")
  WHERE "user_id" IS NULL;
