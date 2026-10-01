import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// errorHandler mengimpor logger -> env (process.exit bila .env tidak dimuat).
vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn() } }));

const { errorHandler } = await import('../../src/middleware/errorHandler.js');
const { MemoryRateLimitStore, RATE_LIMITS, createRateLimiter } = await import(
  '../../src/middleware/rateLimiter.js'
);
const { startServer } = await import('../helpers/http.js');

type TestServer = Awaited<ReturnType<typeof startServer>>;

let clock = 1_000_000;
const now = () => clock;

let server: TestServer;

beforeAll(async () => {
  const app = express();

  // authenticate palsu: pengguna dari header, supaya limiter per-pengguna bisa diuji.
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    if (typeof id === 'string') req.user = { id };
    next();
  });

  const store = new MemoryRateLimitStore();
  app.get('/ip', createRateLimiter({ name: 'ip-test', windowMs: 60_000, max: 3, key: 'ip', store, now }), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/ip-lain', createRateLimiter({ name: 'ip-lain', windowMs: 60_000, max: 3, key: 'ip', store, now }), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/user', createRateLimiter({ name: 'user-test', windowMs: 60_000, max: 2, key: 'user', store, now }), (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('createRateLimiter (per IP)', () => {
  it('mengizinkan hingga batas, lalu 429 RATE_LIMITED dengan Retry-After', async () => {
    clock = 1_000_000;
    for (const remaining of ['2', '1', '0']) {
      const res = await fetch(`${server.url}/ip`);
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe('3');
      expect(res.headers.get('ratelimit-remaining')).toBe(remaining);
    }

    clock += 10_000; // 10 detik berlalu, 50 detik tersisa
    const blocked = await fetch(`${server.url}/ip`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('50');
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
    expect(await blocked.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Terlalu banyak permintaan, coba lagi nanti',
        details: [{ issue: 'rate_limited', retry_after_seconds: 50 }],
      },
    });
  });

  it('terus ditolak selama jendela belum berakhir', async () => {
    clock += 49_000;
    expect((await fetch(`${server.url}/ip`)).status).toBe(429);
  });

  it('jendela baru setelah waktunya habis', async () => {
    clock += 2_000; // total 61 detik sejak permintaan pertama
    const res = await fetch(`${server.url}/ip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-remaining')).toBe('2');
  });

  it('limiter dengan nama berbeda menghitung sendiri-sendiri', async () => {
    clock += 120_000;
    for (let i = 0; i < 3; i++) await fetch(`${server.url}/ip`);
    expect((await fetch(`${server.url}/ip`)).status).toBe(429);
    expect((await fetch(`${server.url}/ip-lain`)).status).toBe(200);
  });
});

describe('createRateLimiter (per pengguna)', () => {
  it('tiap pengguna punya hitungan sendiri', async () => {
    clock += 120_000;
    const hit = (user: string) => fetch(`${server.url}/user`, { headers: { 'x-test-user': user } });

    expect((await hit('user-a')).status).toBe(200);
    expect((await hit('user-a')).status).toBe(200);
    expect((await hit('user-a')).status).toBe(429);

    // user-b, dari IP yang sama, tidak terkena batas user-a
    expect((await hit('user-b')).status).toBe(200);
  });

  it('tanpa authenticate di depannya -> 500 (salah rakit, bukan lolos diam-diam)', async () => {
    const res = await fetch(`${server.url}/user`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('RATE_LIMITS', () => {
  const MINUTE = 60_000;

  it('sesuai tabel ARCHITECTURE.md Bagian 12', () => {
    expect(RATE_LIMITS.global).toEqual({ windowMs: MINUTE, max: 100, key: 'ip' });
    expect(RATE_LIMITS.login).toEqual({ windowMs: 15 * MINUTE, max: 5, key: 'ip' });
    expect(RATE_LIMITS.register).toEqual({ windowMs: 60 * MINUTE, max: 3, key: 'ip' });
    expect(RATE_LIMITS.whatsappLinkRequest).toEqual({ windowMs: 24 * 60 * MINUTE, max: 5, key: 'user' });
    expect(RATE_LIMITS.createTransaction).toEqual({ windowMs: MINUTE, max: 60, key: 'user' });
    expect(RATE_LIMITS.webhook).toEqual({ windowMs: MINUTE, max: 300, key: 'ip' });
  });
});

describe('MemoryRateLimitStore', () => {
  it('menyapu entri kedaluwarsa saat penuh agar memori tidak tumbuh tanpa batas', async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 10_000; i++) await store.hit(`k${i}`, 1_000, 0);
    expect(store.size).toBe(10_000);

    // Pada t=5000 semua entri lama sudah kedaluwarsa; hit yang melewati ambang memicu penyapuan.
    await store.hit('baru-1', 1_000, 5_000);
    expect(store.size).toBeLessThan(10_000);
    expect(store.size).toBe(1);
  });

  it('entri yang belum kedaluwarsa tidak ikut disapu', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('hidup', 100_000, 0);
    for (let i = 0; i < 10_000; i++) await store.hit(`k${i}`, 1_000, 0);
    await store.hit('pemicu', 1_000, 5_000);
    const survivor = await store.hit('hidup', 100_000, 5_000);
    expect(survivor.count).toBe(2);
  });
});
