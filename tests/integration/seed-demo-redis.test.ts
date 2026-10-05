// Test pembersih state percakapan untuk `seed:reset`, terhadap Redis asli. Dilewati bila Redis
// tidak menyala. Id pengguna acak per test; hanya kunci miliknya yang disentuh.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { clearConversationState, clearConversationStateAt } from '../../prisma/seed-demo-redis.js';
import { pendingKey } from '../../src/lib/pendingState.js';
import { userLockKey } from '../../src/lib/userLock.js';

const redisUrl = inject('testRedisUrl');

describe.skipIf(!redisUrl)('seed demo: pembersih state Redis (integrasi)', () => {
  let redis: Redis;
  const usedUsers = new Set<string>();

  const newUser = (): string => {
    const id = randomUUID();
    usedUsers.add(id);
    return id;
  };

  beforeAll(() => {
    redis = new Redis(redisUrl);
  });

  afterEach(async () => {
    await Promise.all([...usedUsers].map((id) => redis.del(pendingKey(id), userLockKey(id))));
    usedUsers.clear();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('menghapus pending dan lock pengguna itu saja', async () => {
    const demo = newUser();
    const other = newUser();
    await redis.set(pendingKey(demo), '{"kind":"confirmation"}', 'EX', 60);
    await redis.set(userLockKey(demo), 'token', 'EX', 60);
    await redis.set(pendingKey(other), '{"kind":"confirmation"}', 'EX', 60);

    expect(await clearConversationState(redis, demo)).toBe(2);

    expect(await redis.exists(pendingKey(demo), userLockKey(demo))).toBe(0);
    expect(await redis.exists(pendingKey(other))).toBe(1);
  });

  it('tidak ada yang dihapus bila memang kosong', async () => {
    expect(await clearConversationState(redis, newUser())).toBe(0);
  });

  it('versi satu-kali-pakai membuka koneksinya sendiri dan melapor jumlahnya', async () => {
    const demo = newUser();
    await redis.set(pendingKey(demo), '{"kind":"confirmation"}', 'EX', 60);

    expect(await clearConversationStateAt(redisUrl, demo)).toEqual({ ok: true, removed: 1 });
    expect(await redis.exists(pendingKey(demo))).toBe(0);
  });
});

describe('seed demo: Redis tidak menyala', () => {
  it('dilaporkan sebagai hasil, bukan galat, dan tidak menggantung', async () => {
    // Port tertutup di localhost: koneksi ditolak seketika.
    const result = await clearConversationStateAt('redis://127.0.0.1:1', randomUUID());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe('');
  });
});
