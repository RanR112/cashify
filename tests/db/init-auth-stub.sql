-- Hanya untuk Postgres test (docker compose service `postgres-test`), BUKAN untuk Supabase.
--
-- Supabase memiliki skema `auth` sendiri. Migrasi `link_users_to_auth` memasang FK
-- users.id -> auth.users(id) hanya bila skema itu ada. Stub minimal ini membuat FK
-- terpasang di database test, jadi test memeriksa perilaku yang sama dengan produksi:
-- baris users tidak bisa ada tanpa baris auth.users-nya.
--
-- Migrasi RLS dan Realtime sengaja tidak dipenuhi (role `authenticated` dan publication
-- tidak dibuat); keduanya punya penjaga dan dilewati di database non-Supabase.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);
