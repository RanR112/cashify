// Pembatas laju. Tabel batas: ARCHITECTURE.md Bagian 12. Penyimpanan di balik interface
// supaya P10 bisa menukar in-memory dengan Redis (INCR + EXPIRE) tanpa mengubah pemanggil.
// In-memory cukup untuk proses lokal tunggal; tidak dibagi antar-proses.
//
// Jendela tetap (fixed window): di pergantian jendela, burst hingga 2x batas dimungkinkan.
// Untuk tujuan di sini (menahan penyalahgunaan, bukan penagihan) itu bisa diterima.

import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/AppError.js';

export interface RateLimitHit {
  count: number;
  /** Epoch ms saat jendela berakhir. */
  resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

const SWEEP_THRESHOLD = 10_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, RateLimitHit>();

  /** Jumlah kunci yang sedang disimpan. Untuk test penyapuan. */
  get size(): number {
    return this.entries.size;
  }

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;

    if (this.entries.size > SWEEP_THRESHOLD) {
      for (const [k, v] of this.entries) {
        if (v.resetAt <= now) this.entries.delete(k);
      }
    }
    return { ...entry };
  }
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  /** 'ip' untuk endpoint publik; 'user' butuh `authenticate` lebih dulu. */
  key: 'ip' | 'user';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Batas dari ARCHITECTURE.md Bagian 12. Batas 3 per nomor per hari adalah logika service. */
export const RATE_LIMITS = {
  global: { windowMs: MINUTE, max: 100, key: 'ip' },
  login: { windowMs: 15 * MINUTE, max: 5, key: 'ip' },
  register: { windowMs: HOUR, max: 3, key: 'ip' },
  whatsappLinkRequest: { windowMs: DAY, max: 5, key: 'user' },
  createTransaction: { windowMs: MINUTE, max: 60, key: 'user' },
  // Sengaja longgar: respons 429 dianggap gagal oleh OpenWA, memicu kiriman ulang, memicu 429 lagi.
  webhook: { windowMs: MINUTE, max: 300, key: 'ip' },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimiterOptions extends RateLimitConfig {
  /** Nama unik; menjadi awalan kunci agar batas berbeda tidak saling menghitung. */
  name: string;
  store?: RateLimitStore;
  /** Penyuntik jam untuk test. */
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? Date.now;

  return async (req, res, next) => {
    let identity: string;
    if (options.key === 'user') {
      if (!req.user) {
        next(new Error(`Pembatas laju "${options.name}" butuh authenticate sebelum dirinya`));
        return;
      }
      identity = req.user.id;
    } else {
      identity = req.ip ?? 'unknown';
    }

    const current = now();
    const { count, resetAt } = await store.hit(`${options.name}:${identity}`, options.windowMs, current);
    const resetSeconds = Math.max(Math.ceil((resetAt - current) / 1000), 1);

    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(options.max - count, 0)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (count > options.max) {
      res.setHeader('Retry-After', String(resetSeconds));
      next(AppError.rateLimited(resetSeconds));
      return;
    }
    next();
  };
}

/** Pembatas bawaan menurut nama. Dipanggil saat merakit router, sehingga tiap app punya store sendiri. */
export function rateLimit(name: RateLimitName, store?: RateLimitStore): RequestHandler {
  return createRateLimiter({ name, ...RATE_LIMITS[name], ...(store && { store }) });
}
