// Koneksi Redis. Sengaja berupa fungsi, bukan klien global: mengimpor berkas ini tidak membuka
// koneksi, dan pemanggil (worker.ts, test) memegang siklus hidup koneksinya sendiri.
//
// Dua jenis koneksi karena kebutuhannya berlawanan:
//  - BullMQ: `maxRetriesPerRequest: null`. Perintah pemblokirnya menunggu tanpa batas, dan BullMQ
//    menolak (memperingatkan) koneksi yang bukan null.
//  - Helper (lock, state percakapan): gagal cepat. Pesan pengguna tidak boleh menggantung
//    selamanya hanya karena Redis sedang mati; job gagal lalu dicoba ulang oleh BullMQ.

import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

function attachLogging(client: Redis, name: string): Redis {
  // Tanpa listener `error`, ioredis hanya mencetak peringatan ke stderr; dengan listener
  // kegagalan masuk log terstruktur, dan ioredis tetap mencoba menyambung ulang sendiri.
  client.on('error', (err) => logger.error({ err, redis: name }, 'Kesalahan koneksi Redis'));
  return client;
}

/** Klien untuk helper lock dan state percakapan. */
export function createRedisClient(url: string = env.REDIS_URL): Redis {
  return attachLogging(new Redis(url, { maxRetriesPerRequest: 3 }), 'helper');
}

/** Koneksi untuk antrean dan worker BullMQ. */
export function createBullConnection(url: string = env.REDIS_URL): Redis {
  return attachLogging(new Redis(url, { maxRetriesPerRequest: null }), 'bullmq');
}
