// Batas validasi yang dipakai bersama. Uang selalu Int rupiah (LOCAL-MODE.md).

/** Batas atas satu transaksi: Rp1 miliar. Jauh di bawah batas Int32 kolom `amount`. */
export const MAX_TRANSACTION_AMOUNT = 1_000_000_000;

/** Batas atas kolom Int PostgreSQL; dipakai untuk saldo awal. */
export const MAX_INT32 = 2_147_483_647;

export const MAX_DESCRIPTION_LENGTH = 255;

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
