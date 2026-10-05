// Lock per pengguna di Redis: `lock:user:{user_id}`, TTL 30 detik.
//
// Kenapa ada: pengguna mengirim "makan 25 ribu" lalu "ya" sedetik kemudian, sebelum bot
// sempat menyimpan pending. Dua webhook tiba hampir bersamaan, dua worker mengambilnya
// paralel, dan "ya" diproses saat pending belum tersimpan (ARCHITECTURE.md Bagian 13).
// Lock memaksa pesan satu pengguna diproses berurutan; pengguna berbeda tetap paralel.
//
// Worker yang gagal mendapat lock menunggu 500 ms lalu mencoba lagi, maksimal 5 kali
// (percobaan pertama + 5 percobaan ulang = 6 percobaan, paling lama ±2,5 detik). Setelah itu
// `UserLockTimeoutError` dilempar dan job gagal; BullMQ yang mengulangnya sesuai `attempts`.
//
// Tidak ada perpanjangan otomatis: pekerjaan yang melewati TTL kehilangan lock-nya. Itu
// disengaja, supaya worker yang mati tidak menahan pengguna lebih lama dari 30 detik.
//
// Tidak mengimpor config/env: klien Redis disuntik, jadi helper ini bisa diuji sendirian.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { requireUserId } from '../shared/utils/userScope.js';

export const LOCK_TTL_MS = 30_000;
export const LOCK_RETRY_DELAY_MS = 500;
export const LOCK_MAX_RETRIES = 5;

/** Kunci hanya dibangun dari UUID: id sembarang tidak boleh menyusup ke nama kunci. */
export const userLockKey = (userId: string): string => `lock:user:${requireUserId(userId)}`;

// Hanya pemilik (token yang cocok) yang boleh melepas. Tanpa pemeriksaan ini, worker yang
// lock-nya sudah kedaluwarsa akan menghapus lock milik worker lain yang baru masuk.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export interface UserLock {
  readonly key: string;
  readonly token: string;
  /** True bila lock ini yang dihapus; false bila sudah kedaluwarsa atau berpindah tangan. */
  release(): Promise<boolean>;
}

export interface AcquireOptions {
  ttlMs?: number;
}

/** Satu percobaan, tanpa menunggu. Null bila lock sedang dipegang pihak lain. */
export async function acquireUserLock(
  redis: Redis,
  userId: string,
  { ttlMs = LOCK_TTL_MS }: AcquireOptions = {},
): Promise<UserLock | null> {
  const key = userLockKey(userId);
  const token = randomUUID();
  if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') return null;
  return {
    key,
    token,
    release: async () => (await redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1,
  };
}

export class UserLockTimeoutError extends Error {
  constructor(
    readonly userId: string,
    readonly attempts: number,
  ) {
    super(`Gagal mendapatkan lock pengguna setelah ${attempts} percobaan`);
    this.name = 'UserLockTimeoutError';
  }
}

export interface WithUserLockOptions extends AcquireOptions {
  retryDelayMs?: number;
  maxRetries?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Menjalankan `fn` selagi memegang lock pengguna, dan selalu melepasnya sesudahnya (juga bila
 * `fn` melempar). Melempar `UserLockTimeoutError` bila lock tidak kunjung didapat.
 */
export async function withUserLock<T>(
  redis: Redis,
  userId: string,
  fn: () => Promise<T>,
  { ttlMs, retryDelayMs = LOCK_RETRY_DELAY_MS, maxRetries = LOCK_MAX_RETRIES }: WithUserLockOptions = {},
): Promise<T> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const lock = await acquireUserLock(redis, userId, ttlMs === undefined ? {} : { ttlMs });
    if (lock) {
      try {
        return await fn();
      } finally {
        // Gagal melepas (mis. Redis terputus) tidak boleh menutupi hasil atau galat `fn`;
        // TTL yang melepas lock pada akhirnya.
        await lock.release().catch(() => false);
      }
    }
    if (attempts > maxRetries) throw new UserLockTimeoutError(userId, attempts);
    await sleep(retryDelayMs);
  }
}
