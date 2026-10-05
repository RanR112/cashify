// Test state percakapan (transaksi pending) terhadap Redis asli. Dilewati bila Redis tidak
// menyala. Id pengguna acak per test; hanya kunci miliknya yang dihapus.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { createPendingStore, PENDING_TTL_SECONDS, pendingKey } from '../../src/lib/pendingState.js';

const redisUrl = inject('testRedisUrl');

// Bentuk uji; bentuk pending sebenarnya milik logika WhatsApp yang belum ada.
const pendingSchema = z.object({ type: z.enum(['income', 'expense']), amount: z.int().positive(), note: z.string() });

describe.skipIf(!redisUrl)('state percakapan (integrasi, Redis)', () => {
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
    await Promise.all([...usedUsers].map((id) => redis.del(pendingKey(id))));
    usedUsers.clear();
  });

  afterAll(async () => {
    await redis.quit();
  });

  const store = () => createPendingStore(redis, pendingSchema);

  it('menyimpan dan membaca kembali, di kunci pending:{id}', async () => {
    const user = newUser();

    await store().set(user, { type: 'expense', amount: 25_000, note: 'makan siang' });

    expect(await store().get(user)).toEqual({ type: 'expense', amount: 25_000, note: 'makan siang' });
    expect(await redis.exists(`pending:${user}`)).toBe(1);
  });

  it('TTL 15 menit', async () => {
    const user = newUser();

    await store().set(user, { type: 'expense', amount: 1000, note: 'a' });

    const ttl = await redis.ttl(pendingKey(user));
    expect(PENDING_TTL_SECONDS).toBe(900);
    expect(ttl).toBeGreaterThan(PENDING_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(PENDING_TTL_SECONDS);
  });

  it('pengguna tanpa pending: null', async () => {
    expect(await store().get(newUser())).toBeNull();
  });

  it('satu pending per pengguna: yang baru menimpa yang lama dan memulai ulang TTL', async () => {
    const user = newUser();
    await createPendingStore(redis, pendingSchema, { ttlSeconds: 60 }).set(user, {
      type: 'expense',
      amount: 1000,
      note: 'lama',
    });
    expect(await redis.ttl(pendingKey(user))).toBeLessThanOrEqual(60);

    await store().set(user, { type: 'income', amount: 2000, note: 'baru' });

    expect(await store().get(user)).toEqual({ type: 'income', amount: 2000, note: 'baru' });
    expect(await redis.ttl(pendingKey(user))).toBeGreaterThan(60); // TTL 900 menggantikan sisa 60
    expect(await redis.keys(`pending:${user}*`)).toEqual([`pending:${user}`]);
  });

  it('pengguna berbeda tidak saling melihat atau menimpa', async () => {
    const [a, b] = [newUser(), newUser()];

    await store().set(a, { type: 'expense', amount: 1000, note: 'milik A' });
    await store().set(b, { type: 'income', amount: 9000, note: 'milik B' });

    expect((await store().get(a))?.note).toBe('milik A');
    expect((await store().get(b))?.note).toBe('milik B');
    await store().clear(a);
    expect(await store().get(a)).toBeNull();
    expect((await store().get(b))?.note).toBe('milik B');
  });

  it('clear menghapus pending dan aman dipanggil saat tidak ada', async () => {
    const user = newUser();
    await store().set(user, { type: 'expense', amount: 1000, note: 'a' });

    await store().clear(user);
    await store().clear(user);

    expect(await store().get(user)).toBeNull();
  });

  it('kedaluwarsa sendiri sesuai TTL', async () => {
    const user = newUser();
    await createPendingStore(redis, pendingSchema, { ttlSeconds: 1 }).set(user, {
      type: 'expense',
      amount: 1000,
      note: 'a',
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(await store().get(user)).toBeNull();
  });

  it('isi yang bukan JSON atau tidak sesuai skema dibaca sebagai tidak ada', async () => {
    const user = newUser();

    await redis.set(pendingKey(user), '{bukan json');
    expect(await store().get(user)).toBeNull();

    await redis.set(pendingKey(user), JSON.stringify({ type: 'transfer', amount: -5, note: 1 }));
    expect(await store().get(user)).toBeNull();
  });

  it('set menolak nilai yang tidak sesuai skema dan tidak menulis apa pun', async () => {
    const user = newUser();

    await expect(store().set(user, { type: 'expense', amount: 12.5, note: 'a' })).rejects.toThrow();

    expect(await redis.exists(pendingKey(user))).toBe(0);
  });

  it('menolak id pengguna yang bukan UUID', async () => {
    await expect(store().get('*')).rejects.toThrow(TypeError);
    await expect(store().set('bukan-uuid', { type: 'expense', amount: 1000, note: 'a' })).rejects.toThrow(TypeError);
  });
});
