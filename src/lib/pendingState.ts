// State percakapan: transaksi yang menunggu konfirmasi ("ya" atau "batal") di Redis.
//
// Kunci `pending:{user_id}`, TTL 15 menit. Sengaja tidak di PostgreSQL: sifatnya sementara.
// Kedaluwarsa tidak memicu pesan pengingat; mengirim pesan yang tidak diminta adalah perilaku
// yang berisiko membuat nomor bot diblokir (ARCHITECTURE.md Bagian 7).
//
// Satu pending per pengguna: `SET` biasa menimpa nilai lama sekaligus mengulang TTL-nya, jadi
// pending baru membuang yang lama tanpa pemeriksaan tambahan.
//
// Isi pending adalah urusan logika WhatsApp yang belum ada, jadi store menerima skema Zod dari
// pemanggil. Data dari Redis tetap divalidasi di batas ini.

import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { requireUserId } from '../shared/utils/userScope.js';

export const PENDING_TTL_SECONDS = 15 * 60;

export const pendingKey = (userId: string): string => `pending:${requireUserId(userId)}`;

export interface PendingStoreOptions {
  ttlSeconds?: number;
}

export function createPendingStore<S extends z.ZodType>(
  redis: Redis,
  schema: S,
  { ttlSeconds = PENDING_TTL_SECONDS }: PendingStoreOptions = {},
) {
  return {
    /** Menyimpan pending, menimpa yang lama, dan memulai ulang TTL. */
    async set(userId: string, value: z.input<S>): Promise<void> {
      const parsed = schema.parse(value);
      await redis.set(pendingKey(userId), JSON.stringify(parsed), 'EX', ttlSeconds);
    },

    /**
     * Null bila tidak ada, sudah kedaluwarsa, atau isinya rusak/tidak sesuai skema. Isi yang
     * rusak tidak dihapus di sini (bisa saja baru ditimpa pihak lain di antara baca dan hapus);
     * ia kedaluwarsa sendiri atau ditimpa `set` berikutnya.
     */
    async get(userId: string): Promise<z.output<S> | null> {
      const raw = await redis.get(pendingKey(userId));
      if (raw === null) return null;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return null;
      }
      const result = schema.safeParse(json);
      return result.success ? result.data : null;
    },

    async clear(userId: string): Promise<void> {
      await redis.del(pendingKey(userId));
    },
  };
}
