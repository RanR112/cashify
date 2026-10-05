// Test antrean dan worker terhadap Redis + BullMQ asli (docker compose up -d redis). Dilewati bila
// Redis tidak menyala. Semua kunci memakai awalan unik per test dan dihapus sesudahnya, jadi
// aman dijalankan pada Redis pengembangan.
//
// Yang dikunci di sini: outbound concurrency 1 dengan jeda acak 2-5 detik (aturan 12), inbound
// paralel, tidak ada job ganda untuk pesan yang sama, dan penutupan worker yang cepat.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import {
  createQueues,
  enqueueInbound,
  enqueueOutbound,
  INBOUND_CONCURRENCY,
  OUTBOUND_CONCURRENCY,
  OUTBOUND_DELAY_MAX_MS,
  OUTBOUND_DELAY_MIN_MS,
  type InboundJobData,
  type Queues,
} from '../../src/queues/index.js';
import { startWorkers, type StartedWorkers, type StartWorkersOptions } from '../../src/workers/index.js';

vi.mock('../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const redisUrl = inject('testRedisUrl');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timeout menunggu: ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!redisUrl)('antrean dan worker (integrasi, Redis + BullMQ)', () => {
  let connection: Redis;
  let queues: Queues;
  let workers: StartedWorkers | undefined;
  let prefix: string;

  /** Antrean + (opsional) worker dengan awalan unik. */
  async function setup(options: Omit<StartWorkersOptions, 'prefix'> | null = {}): Promise<void> {
    prefix = `test-${randomUUID()}`;
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queues = createQueues(connection, { prefix });
    if (options) {
      workers = startWorkers(connection, { ...options, prefix });
      await workers.ready();
    }
  }

  afterEach(async () => {
    await workers?.close();
    workers = undefined;
    await Promise.all([queues.inbound.obliterate({ force: true }), queues.outbound.obliterate({ force: true })]);
    await Promise.all([queues.inbound.close(), queues.outbound.close()]);
    await connection.quit();
  });

  describe('outbound (aturan 12)', () => {
    it('concurrency 1: tidak pernah ada dua pengiriman bersamaan', async () => {
      let active = 0;
      let maxActive = 0;
      let done = 0;
      await setup({
        outbound: {
          pause: async () => undefined, // jeda dimatikan: yang diuji di sini hanya concurrency
          send: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(120);
            active -= 1;
            done += 1;
          },
        },
      });

      for (let i = 0; i < 4; i++) await enqueueOutbound(queues.outbound, { wa_chat_id: 'x@c.us', text: `balasan ${i}` });
      await waitFor(() => done === 4, 10_000, '4 pengiriman selesai');

      expect(workers?.outbound.opts.concurrency).toBe(OUTBOUND_CONCURRENCY);
      expect(OUTBOUND_CONCURRENCY).toBe(1);
      expect(maxActive).toBe(1);
    });

    it('jeda acak 2-5 detik antar pekerjaan (waktu nyata)', { timeout: 40_000 }, async () => {
      const startedAt: number[] = [];
      await setup({
        outbound: {
          send: async () => {
            startedAt.push(Date.now());
          },
        },
      });

      for (let i = 0; i < 3; i++) await enqueueOutbound(queues.outbound, { wa_chat_id: 'x@c.us', text: `balasan ${i}` });
      await waitFor(() => startedAt.length === 3, 30_000, '3 pengiriman dimulai');

      const gaps = [startedAt[1]! - startedAt[0]!, startedAt[2]! - startedAt[1]!];
      for (const gap of gaps) {
        // Toleransi kecil untuk penjadwalan timer dan pengambilan job berikutnya.
        expect(gap).toBeGreaterThanOrEqual(OUTBOUND_DELAY_MIN_MS - 50);
        expect(gap).toBeLessThanOrEqual(OUTBOUND_DELAY_MAX_MS + 1500);
      }
    });

    it('jeda tetap berlaku setelah pengiriman yang gagal', async () => {
      const pause = vi.fn(async () => undefined);
      let sends = 0;
      await setup({
        outbound: {
          pause,
          send: async () => {
            sends += 1;
            throw new Error('gateway mati');
          },
        },
      });

      await enqueueOutbound(queues.outbound, { wa_chat_id: 'x@c.us', text: 'halo' });
      await waitFor(() => sends >= 1 && pause.mock.calls.length >= 1, 5000, 'percobaan pertama dan jedanya');

      expect(pause).toHaveBeenCalledTimes(sends);
    });

    it('data job yang rusak tidak dicoba ulang dan tidak memicu pengiriman maupun jeda', async () => {
      const send = vi.fn(async () => undefined);
      const pause = vi.fn(async () => undefined);
      await setup({ outbound: { send, pause } });

      // Menyelinap lewat antrean langsung (produsen resmi menolak data seperti ini).
      await queues.outbound.add('send-message', { wa_chat_id: '', text: '' });
      await waitFor(async () => (await queues.outbound.getFailedCount()) === 1, 5000, 'job gagal');

      const [failed] = await queues.outbound.getFailed();
      expect(failed?.attemptsMade).toBe(1);
      expect(send).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    });

    it('menutup worker saat sedang dalam jeda berlangsung cepat (jeda dibatalkan), bukan menunggu hingga 5 detik', async () => {
      let sent = false;
      await setup({
        outbound: {
          send: async () => {
            sent = true;
          },
        },
      });

      await enqueueOutbound(queues.outbound, { wa_chat_id: 'x@c.us', text: 'halo' });
      await waitFor(() => sent, 5000, 'pengiriman dimulai');
      await sleep(100); // pastikan processor sudah masuk ke jeda

      const started = Date.now();
      await workers?.close();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1000);
      // Pengiriman sudah selesai; yang dibatalkan hanya jedanya, jadi job tetap tercatat selesai.
      expect(await queues.outbound.getCompletedCount()).toBe(1);
    });
  });

  describe('inbound', () => {
    it('concurrency normal: beberapa job diproses bersamaan', async () => {
      let active = 0;
      let maxActive = 0;
      let done = 0;
      await setup({
        inbound: {
          processor: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(300);
            active -= 1;
            done += 1;
          },
        },
      });

      for (let i = 0; i < 3; i++) await enqueueInbound(queues.inbound, { message_log_id: randomUUID() });
      await waitFor(() => done === 3, 10_000, '3 job inbound selesai');

      expect(workers?.inbound.opts.concurrency).toBe(INBOUND_CONCURRENCY);
      expect(maxActive).toBeGreaterThanOrEqual(2);
    });

    it('pesan yang sama dimasukkan dua kali menghasilkan satu job', async () => {
      await setup(null); // tanpa worker: job tetap menunggu sehingga bisa dihitung
      const id = randomUUID();

      await enqueueInbound(queues.inbound, { message_log_id: id });
      await enqueueInbound(queues.inbound, { message_log_id: id });

      expect(await queues.inbound.getWaitingCount()).toBe(1);
      expect((await queues.inbound.getJob(id))?.data).toEqual({ message_log_id: id });
    });

    it('produsen menolak data yang salah dan tidak memasukkan apa pun', async () => {
      await setup(null);

      await expect(enqueueInbound(queues.inbound, { message_log_id: 'bukan-uuid' })).rejects.toThrow();
      await expect(enqueueOutbound(queues.outbound, { wa_chat_id: '', text: 'x' })).rejects.toThrow();

      expect(await queues.inbound.getWaitingCount()).toBe(0);
      expect(await queues.outbound.getWaitingCount()).toBe(0);
    });

    it('job dengan data rusak gagal sekali tanpa percobaan ulang dan tidak memanggil pemroses', async () => {
      const processor = vi.fn(async () => undefined);
      await setup({ inbound: { processor } });

      await queues.inbound.add('process-message', { message_log_id: 'rusak' } as never);
      await waitFor(async () => (await queues.inbound.getFailedCount()) === 1, 5000, 'job gagal');

      const [failed] = await queues.inbound.getFailed();
      expect(failed?.attemptsMade).toBe(1); // attempts 3 tidak dipakai: data salah tidak akan membaik
      expect(processor).not.toHaveBeenCalled();
    });

    it('job normal diteruskan ke pemroses dengan data yang sudah divalidasi', async () => {
      const processor = vi.fn<(data: InboundJobData) => Promise<void>>(async () => undefined);
      await setup({ inbound: { processor } });
      const id = randomUUID();

      await enqueueInbound(queues.inbound, { message_log_id: id });
      await waitFor(() => processor.mock.calls.length === 1, 5000, 'pemroses dipanggil');

      expect(processor.mock.calls[0]?.[0]).toEqual({ message_log_id: id });
    });
  });

  describe('startWorkers', () => {
    it('close() menutup kedua worker dan bisa dipanggil dua kali', async () => {
      await setup();

      await workers?.close();
      await workers?.close();

      expect(workers?.inbound.isRunning()).toBe(false);
      expect(workers?.outbound.isRunning()).toBe(false);
    });
  });
});
