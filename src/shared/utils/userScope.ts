// Pengaman filter user_id untuk repository. Prisma adalah pemilik tabel, jadi RLS tidak
// menangkap kueri yang lupa memfilter (BACKEND-STRUCTURE.md 4.3): filter di sini adalah
// pertahanan utama. Murni; tidak mengimpor Prisma maupun modul.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prisma MEMBUANG kondisi `{ userId: undefined }` dari `where`, sehingga `userId` yang
 * lupa diisi menghasilkan kueri tanpa filter dan mengembalikan baris semua pengguna.
 * Setiap metode repository memanggil ini lebih dulu agar kegagalannya keras, bukan diam.
 */
export function requireUserId(userId: unknown): string {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new TypeError('userId wajib berupa UUID dari klaim JWT');
  }
  return userId;
}

/** Baris milik pengguna ini yang belum di-soft-delete. */
export function ownedBy(userId: string): { userId: string; deletedAt: null } {
  return { userId: requireUserId(userId), deletedAt: null };
}

/** Baris sistem (user_id NULL) ditambah milik pengguna ini, belum di-soft-delete. */
export function visibleTo(userId: string): { OR: [{ userId: null }, { userId: string }]; deletedAt: null } {
  return { OR: [{ userId: null }, { userId: requireUserId(userId) }], deletedAt: null };
}
