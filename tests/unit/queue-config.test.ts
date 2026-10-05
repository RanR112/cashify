// Konfigurasi yang TIDAK BOLEH berubah diam-diam, ditambah fungsi murni di sekitar antrean dan
// kunci Redis. Tanpa Redis. Perilaku lock/antrean yang sebenarnya ada di tests/integration/.

import { describe, expect, it, vi } from 'vitest';
import { PENDING_TTL_SECONDS, pendingKey } from '../../src/lib/pendingState.js';
import { LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_TTL_MS, userLockKey } from '../../src/lib/userLock.js';
import {
  INBOUND_CONCURRENCY,
  INBOUND_JOB_OPTIONS,
  inboundJobSchema,
  OUTBOUND_CONCURRENCY,
  OUTBOUND_DELAY_MAX_MS,
  OUTBOUND_DELAY_MIN_MS,
  OUTBOUND_JOB_OPTIONS,
  outboundJobSchema,
  randomDelayMs,
} from '../../src/queues/index.js';
import { abortableSleep } from '../../src/workers/outbound.worker.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const USER_ID = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';

describe('konfigurasi yang tidak boleh berubah', () => {
  it('outbound: concurrency 1 dan jeda acak 2 sampai 5 detik (aturan 12)', () => {
    expect(OUTBOUND_CONCURRENCY).toBe(1);
    expect(OUTBOUND_DELAY_MIN_MS).toBe(2000);
    expect(OUTBOUND_DELAY_MAX_MS).toBe(5000);
  });

  it('inbound: concurrency normal, lebih dari 1', () => {
    expect(INBOUND_CONCURRENCY).toBeGreaterThan(1);
  });

  it('lock per pengguna: TTL 30 detik, jeda 500 ms, maksimal 5 percobaan ulang', () => {
    expect(LOCK_TTL_MS).toBe(30_000);
    expect(LOCK_RETRY_DELAY_MS).toBe(500);
    expect(LOCK_MAX_RETRIES).toBe(5);
  });

  it('state percakapan: TTL 15 menit', () => {
    expect(PENDING_TTL_SECONDS).toBe(15 * 60);
  });

  it('kedua antrean mencoba ulang job yang gagal tiga kali', () => {
    expect(INBOUND_JOB_OPTIONS.attempts).toBe(3);
    expect(OUTBOUND_JOB_OPTIONS.attempts).toBe(3);
  });
});

describe('randomDelayMs', () => {
  it('batas bawah dan atas inklusif, selalu bilangan bulat', () => {
    expect(randomDelayMs(() => 0)).toBe(2000);
    expect(randomDelayMs(() => 0.999_999_999)).toBe(5000);
  });

  it('seluruh hasil dari rng sungguhan berada di rentang dan tidak konstan', () => {
    const values = Array.from({ length: 2000 }, () => randomDelayMs());
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(2000);
      expect(value).toBeLessThanOrEqual(5000);
    }
    expect(new Set(values).size).toBeGreaterThan(100);
    // Jeda acak sungguhan: kedua separuh rentang terpakai (bukan hanya dekat satu ujung).
    expect(values.some((v) => v < 3000)).toBe(true);
    expect(values.some((v) => v > 4000)).toBe(true);
  });
});

describe('abortableSleep', () => {
  it('selesai setelah waktunya bila tidak dibatalkan', async () => {
    const started = Date.now();
    await abortableSleep(60, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('selesai seketika bila dibatalkan di tengah jalan', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('tidak tidur sama sekali bila sudah dibatalkan', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await abortableSleep(5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('nama kunci Redis', () => {
  it('lock:user:{id} dan pending:{id} persis', () => {
    expect(userLockKey(USER_ID)).toBe(`lock:user:${USER_ID}`);
    expect(pendingKey(USER_ID)).toBe(`pending:${USER_ID}`);
  });

  it.each(['', 'bukan-uuid', `${USER_ID}:ekstra`, `${USER_ID}*`, '*', '../../x'])(
    'menolak id yang bukan UUID: %j',
    (id) => {
      expect(() => userLockKey(id)).toThrow(TypeError);
      expect(() => pendingKey(id)).toThrow(TypeError);
    },
  );
});

describe('skema job', () => {
  it('inbound hanya membawa id pesan', () => {
    expect(inboundJobSchema.parse({ message_log_id: USER_ID })).toEqual({ message_log_id: USER_ID });
    expect(() => inboundJobSchema.parse({ message_log_id: 'bukan-uuid' })).toThrow();
    expect(() => inboundJobSchema.parse({})).toThrow();
  });

  it('inbound membuang field lain, jadi payload mentah tidak ikut masuk antrean', () => {
    expect(inboundJobSchema.parse({ message_log_id: USER_ID, body: 'rahasia', raw: {} })).toEqual({
      message_log_id: USER_ID,
    });
  });

  it('outbound: chat id dan teks wajib, id pesan opsional', () => {
    expect(outboundJobSchema.parse({ wa_chat_id: '6281200000000@c.us', text: 'halo' })).toEqual({
      wa_chat_id: '6281200000000@c.us',
      text: 'halo',
    });
    expect(() => outboundJobSchema.parse({ wa_chat_id: '', text: 'halo' })).toThrow();
    expect(() => outboundJobSchema.parse({ wa_chat_id: 'x', text: '' })).toThrow();
    expect(() => outboundJobSchema.parse({ wa_chat_id: 'x', text: 'y', message_log_id: 'salah' })).toThrow();
  });
});
