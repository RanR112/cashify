// Membersihkan state percakapan WhatsApp milik pengguna demo di Redis, untuk `seed:reset`.
//
// Tanpa ini, "ya" pertama di demo berikutnya bisa menyimpan transaksi dari pending latihan
// sebelumnya (TTL 15 menit), atau lock pengguna yang tertinggal membuat pesan pertama menunggu.
//
// Best-effort: seed tidak boleh bergantung pada Redis. Redis mati bukan galat, hanya dilaporkan.
// Nama kunci dari helper aplikasi (src/lib), bukan ditulis ulang di sini.

import { Redis } from 'ioredis';
import { pendingKey } from '../src/lib/pendingState.js';
import { userLockKey } from '../src/lib/userLock.js';

const CONNECT_TIMEOUT_MS = 2_000;

/** Menghapus `pending:{id}` dan `lock:user:{id}`. Mengembalikan jumlah kunci yang benar-benar ada. */
export async function clearConversationState(redis: Redis, userId: string): Promise<number> {
  return redis.del(pendingKey(userId), userLockKey(userId));
}

export type ClearStateResult = { ok: true; removed: number } | { ok: false; reason: string };

/** Membuka koneksi sekali pakai, gagal cepat (tanpa menyambung ulang), dan selalu menutupnya. */
export async function clearConversationStateAt(url: string, userId: string): Promise<ClearStateResult> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  // Galat koneksi sampai ke pemanggil lewat promise di bawah; tanpa listener ini ioredis mencetak peringatan.
  redis.on('error', () => undefined);

  try {
    await redis.connect();
    return { ok: true, removed: await clearConversationState(redis, userId) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    redis.disconnect();
  }
}
