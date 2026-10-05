// Test lock per pengguna terhadap Redis asli (docker compose up -d redis). Dilewati bila Redis
// tidak menyala. Tiap test memakai id pengguna acak, dan hanya kunci miliknya yang dihapus,
// jadi aman dijalankan pada Redis pengembangan.
//
// "Worker" di sini adalah koneksi Redis terpisah: dua worker sungguhan juga dua koneksi.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  acquireUserLock,
  LOCK_MAX_RETRIES,
  LOCK_TTL_MS,
  UserLockTimeoutError,
  userLockKey,
  withUserLock,
} from '../../src/lib/userLock.js';

const redisUrl = inject('testRedisUrl');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!redisUrl)('lock per pengguna (integrasi, Redis)', () => {
  let redis: Redis;
  const extraClients: Redis[] = [];
  const usedUsers = new Set<string>();

  const newUser = (): string => {
    const id = randomUUID();
    usedUsers.add(id);
    return id;
  };

  /** Satu koneksi per "worker". */
  const newWorker = (): Redis => {
    const client = new Redis(redisUrl);
    extraClients.push(client);
    return client;
  };

  beforeAll(() => {
    redis = new Redis(redisUrl);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...usedUsers].map((id) => redis.del(userLockKey(id))));
    usedUsers.clear();
    await Promise.all(extraClients.splice(0).map((client) => client.quit()));
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe('acquireUserLock', () => {
    it('lock kedua untuk pengguna yang sama ditolak selagi dipegang; pengguna lain tidak terhalang', async () => {
      const [a, b] = [newUser(), newUser()];

      const first = await acquireUserLock(redis, a);
      const second = await acquireUserLock(redis, a);
      const other = await acquireUserLock(redis, b);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(other).not.toBeNull();
    });

    it('memakai kunci lock:user:{id} dengan TTL 30 detik', async () => {
      const user = newUser();

      const lock = await acquireUserLock(redis, user);

      expect(lock?.key).toBe(`lock:user:${user}`);
      expect(await redis.get(`lock:user:${user}`)).toBe(lock?.token);
      const ttl = await redis.pttl(`lock:user:${user}`);
      expect(ttl).toBeGreaterThan(LOCK_TTL_MS - 2000);
      expect(ttl).toBeLessThanOrEqual(LOCK_TTL_MS);
    });

    it('setelah dilepas, pengguna yang sama bisa mengambilnya lagi; melepas dua kali tidak berdampak', async () => {
      const user = newUser();
      const lock = await acquireUserLock(redis, user);

      expect(await lock?.release()).toBe(true);
      expect(await lock?.release()).toBe(false);
      expect(await acquireUserLock(redis, user)).not.toBeNull();
    });

    it('lock yang tidak dilepas kedaluwarsa sendiri (worker yang mati tidak menahan pengguna)', async () => {
      const user = newUser();
      await acquireUserLock(redis, user, { ttlMs: 100 });

      expect(await acquireUserLock(redis, user)).toBeNull();
      await sleep(180);
      expect(await acquireUserLock(redis, user)).not.toBeNull();
    });

    it('pelepas basi tidak menghapus lock milik worker lain', async () => {
      const user = newUser();
      const stale = await acquireUserLock(redis, user, { ttlMs: 100 });
      await sleep(180); // lock A kedaluwarsa
      const current = await acquireUserLock(redis, user);
      expect(current).not.toBeNull();

      expect(await stale?.release()).toBe(false);

      expect(await redis.get(userLockKey(user))).toBe(current?.token);
      expect(await acquireUserLock(redis, user)).toBeNull();
      expect(await current?.release()).toBe(true);
    });

    it('menolak id pengguna yang bukan UUID', async () => {
      await expect(acquireUserLock(redis, '*')).rejects.toThrow(TypeError);
    });
  });

  describe('withUserLock', () => {
    it('mengembalikan hasil fn dan melepas lock sesudahnya', async () => {
      const user = newUser();

      const result = await withUserLock(redis, user, async () => 42);

      expect(result).toBe(42);
      expect(await redis.exists(userLockKey(user))).toBe(0);
    });

    it('melepas lock juga saat fn melempar galat, dan galat itu sampai ke pemanggil', async () => {
      const user = newUser();

      await expect(
        withUserLock(redis, user, async () => {
          throw new Error('gagal memproses');
        }),
      ).rejects.toThrow('gagal memproses');

      expect(await acquireUserLock(redis, user)).not.toBeNull();
    });

    it('DUA WORKER berebut pengguna yang sama: yang kedua menunggu, bagian kritis tidak tumpang tindih', async () => {
      const user = newUser();
      const workerA = newWorker();
      const workerB = newWorker();
      const log: string[] = [];

      const a = withUserLock(
        workerA,
        user,
        async () => {
          log.push('A:mulai');
          await sleep(300);
          log.push('A:selesai');
        },
        { retryDelayMs: 50 },
      );
      await sleep(60); // pastikan A sudah memegang lock sebelum B datang
      const bStarted = Date.now();
      const b = withUserLock(
        workerB,
        user,
        async () => {
          log.push('B:mulai');
          await sleep(50);
          log.push('B:selesai');
        },
        { retryDelayMs: 50, maxRetries: 20 },
      );

      await Promise.all([a, b]);

      expect(log).toEqual(['A:mulai', 'A:selesai', 'B:mulai', 'B:selesai']);
      expect(Date.now() - bStarted).toBeGreaterThanOrEqual(200); // B benar-benar menunggu A
    });

    it('empat worker serentak untuk satu pengguna: tidak ada pembaruan yang hilang', async () => {
      const user = newUser();
      let counter = 0;
      let active = 0;
      let maxActive = 0;

      // Baca-tidur-tulis: tanpa lock, keempatnya membaca 0 dan hasil akhirnya 1.
      const criticalSection = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const read = counter;
        await sleep(20);
        counter = read + 1;
        active -= 1;
      };

      await Promise.all(
        Array.from({ length: 4 }, () =>
          withUserLock(newWorker(), user, criticalSection, { retryDelayMs: 25, maxRetries: 100 }),
        ),
      );

      expect(counter).toBe(4);
      expect(maxActive).toBe(1);
    });

    it('menyerah setelah 5 percobaan ulang (6 percobaan): UserLockTimeoutError, fn tidak pernah dipanggil', async () => {
      const user = newUser();
      await acquireUserLock(redis, user); // dipegang pihak lain selama test
      const fn = vi.fn(async () => 'tidak boleh jalan');
      const waiter = newWorker();
      const setSpy = vi.spyOn(waiter, 'set');
      const started = Date.now();

      const error = await withUserLock(waiter, user, fn, { retryDelayMs: 20 }).catch((e: unknown) => e);

      expect(LOCK_MAX_RETRIES).toBe(5);
      expect(error).toBeInstanceOf(UserLockTimeoutError);
      expect((error as UserLockTimeoutError).attempts).toBe(6);
      expect((error as UserLockTimeoutError).userId).toBe(user);
      expect(setSpy).toHaveBeenCalledTimes(6);
      expect(fn).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeGreaterThanOrEqual(5 * 20 - 10); // 5 jeda di antara 6 percobaan
    });

    it('batas percobaan ulang bisa disetel', async () => {
      const user = newUser();
      await acquireUserLock(redis, user);

      const error = await withUserLock(redis, user, async () => 1, { retryDelayMs: 5, maxRetries: 2 }).catch(
        (e: unknown) => e,
      );

      expect((error as UserLockTimeoutError).attempts).toBe(3);
    });

    it('lock dilepas di tengah masa tunggu: percobaan ulang kedua berhasil', async () => {
      const user = newUser();
      const holder = await acquireUserLock(redis, user);
      setTimeout(() => void holder?.release(), 150);
      const waiter = newWorker();
      const setSpy = vi.spyOn(waiter, 'set');

      // Percobaan pada t=0 (gagal), t=100 (gagal, lock baru lepas di t=150), t=200 (berhasil).
      const result = await withUserLock(waiter, user, async () => 'berhasil', { retryDelayMs: 100 });

      expect(result).toBe('berhasil');
      expect(setSpy).toHaveBeenCalledTimes(3);
    });

    it('pengguna berbeda berjalan paralel', async () => {
      const [a, b] = [newUser(), newUser()];
      let active = 0;
      let maxActive = 0;
      const section = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(100);
        active -= 1;
      };
      const started = Date.now();

      await Promise.all([withUserLock(newWorker(), a, section), withUserLock(newWorker(), b, section)]);

      expect(maxActive).toBe(2);
      expect(Date.now() - started).toBeLessThan(190);
    });

    it('menolak id pengguna yang bukan UUID sebelum menyentuh Redis', async () => {
      const fn = vi.fn(async () => 1);
      await expect(withUserLock(redis, 'bukan-uuid', fn)).rejects.toThrow(TypeError);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
