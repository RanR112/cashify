# Cashify Backend

API keuangan pribadi dengan dua kanal masuk: REST untuk aplikasi mobile dan webhook WhatsApp (OpenWA). Proyek kuliah, berjalan di lokal, semua layanan gratis. Batasan lengkap ada di [claude/LOCAL-MODE.md](claude/LOCAL-MODE.md).

## Prasyarat

- Node.js 22+
- Docker (hanya untuk Redis)
- Proyek Supabase free tier (Postgres + Auth)
- Satu nomor WhatsApp cadangan untuk bot (jangan nomor pribadi)

## Menjalankan di lokal

```bash
npm install
cp .env.example .env          # isi semua nilainya, aplikasi menolak boot bila ada yang kosong
docker compose up -d redis    # Redis saja; Postgres ada di Supabase
npm run dev                   # API di http://127.0.0.1:3000
npm run dev:worker            # worker, terminal terpisah
```

Periksa:

```bash
curl http://127.0.0.1:3000/health
```

OpenWA (webhook tidak butuh tunnel karena satu mesin):

```bash
npx @open-wa/wa-automate@4.76.0 -w http://localhost:3000/webhooks/openwa/<path>
```

## Perintah lain

```bash
npm run build
npm run test
npm run lint
npm run typecheck
```

## Test integrasi

Test unit selalu jalan. Test integrasi (`tests/integration/`) butuh Postgres polos dengan stub skema `auth` (`tests/db/init-auth-stub.sql`), dan melewati dirinya sendiri dengan pesan jelas bila database itu tidak menyala:

```bash
docker compose up -d postgres-test   # port 54329, data di tmpfs (hilang saat dimatikan)
npm run test                         # migrasi + seed kategori sistem otomatis di database test
docker compose stop postgres-test
```

Alamat bawaan cocok dengan compose; ganti lewat `TEST_DATABASE_URL` bila perlu. Test menghapus isi tabel pengguna, sehingga alamatnya hanya boleh `localhost` atau `127.0.0.1`. Supabase Auth dan Google tidak pernah dipanggil: test memakai `FakeAuthProvider` (`tests/helpers/testDb.ts`).

## Aturan skema database

**Skema hanya diubah lewat `prisma migrate`.** Jangan pernah lewat SQL Editor atau Table Editor di dashboard Supabase — dua sumber kebenaran menghasilkan drift. Migrasi butuh `DIRECT_URL` (port 5432).

Urutan migrasi di `prisma/migrations/` (semuanya harus terterap berurutan):

1. `init_schema` — seluruh tabel; `transactions.date` adalah generated column
2. `add_constraints_and_partial_indexes` — CHECK dan partial index yang tidak bisa ditulis di `schema.prisma`
3. `link_users_to_auth` — FK `users.id` ke `auth.users(id)`
4. `add_rls_policies` — RLS dan policy (hanya SELECT untuk `authenticated`)
5. `enable_realtime_transactions` — publication Realtime dan `REPLICA IDENTITY FULL`

Migrasi 3-5 sengaja dibungkus penjaga agar tetap lolos di shadow database Prisma yang tidak punya skema `auth`. Jangan menghapus penjaganya.

```bash
npx prisma migrate deploy     # terapkan migrasi ke Supabase (pakai DIRECT_URL)
npm run seed                  # kategori sistem + pengguna demo; aman dijalankan berulang
npm run seed:reset            # hapus data demo lalu isi ulang dengan tanggal terbaru
npx prisma migrate dev --create-only --name <nama>   # migrasi baru dengan SQL manual
```

## Data demo

`npm run seed` juga membuat satu pengguna demo lewat Supabase Auth, supaya dashboard dan layar detail bisa diuji tanpa mengetik data. Butuh jaringan dan `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` di `.env`, serta konfirmasi email yang dimatikan di Supabase (sama seperti untuk `/auth/register`).

| | |
| --- | --- |
| Email | `demo@cashify.test` |
| Password | `Demo-Cashify-2026` |

Bila Supabase menolak domain email itu, setel `DEMO_EMAIL` (dan bila perlu `DEMO_PASSWORD`) di `.env`. Nilai itu menggantikan yang di atas.

Isinya: dompet **Tunai** dan **BCA**, saldo awal Rp2.000.000, dan sekitar 170 transaksi untuk tiga bulan kalender terakhir (dua bulan penuh + bulan berjalan sampai hari ini):

- Gaji Rp7.000.000 tiap tanggal 1; dua fee freelance
- Makanan hampir setiap hari (Rp15.000-Rp75.000), transportasi beberapa kali seminggu
- Listrik (tanggal 5, nominal berbeda tiap bulan), internet Rp349.000 (tanggal 10), Spotify (tanggal 15)
- Belanja sesekali, satu pembelian besar di bulan tengah, hiburan dan kesehatan sesekali
- 10 transaksi `source = 'whatsapp'` beserta baris `message_logs`-nya (layar detail menampilkan pesan asalnya)
- 5 transaksi yang sudah di-soft-delete, dan jejak `audit_logs` untuk semuanya

| Perintah | Perilaku |
| --- | --- |
| `npm run seed` | Membuat pengguna, dompet, dan transaksi bila belum ada. Bila pengguna demo sudah punya transaksi, dilewati; tidak menimpa apa pun, termasuk yang Anda tambahkan sendiri. |
| `npm run seed:reset` | Menghapus transaksi, pesan, audit, dan dompet tambahan milik pengguna demo, lalu mengisi ulang. Pakai ini bila datanya sudah menua: tanggal dihitung dari hari ini. Pengguna lain tidak disentuh. |

## Dokumen rancangan

Ada di [claude/](claude/). Baca `LOCAL-MODE.md` lebih dulu; bila bertentangan dengan `ARCHITECTURE.md`, `LOCAL-MODE.md` yang berlaku.
