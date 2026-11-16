import type { ConnectionOptions, Worker } from 'bullmq';
import type { QueueFactoryOptions } from '../queues/inbound.queue.js';
import { createInboundWorker, type InboundWorkerOptions } from './inbound.worker.js';
import { createOutboundWorker, type OutboundWorkerOptions } from './outbound.worker.js';
import { createScheduledWorker, type ScheduledWorkerOptions } from './scheduled.worker.js';

export interface StartWorkersOptions extends QueueFactoryOptions {
  inbound?: Omit<InboundWorkerOptions, 'prefix'>;
  outbound?: Omit<OutboundWorkerOptions, 'prefix'>;
  scheduled?: Omit<ScheduledWorkerOptions, 'prefix'>;
}

export interface StartedWorkers {
  inbound: Worker;
  outbound: Worker;
  scheduled: Worker;
  /** Semua worker sudah terhubung dan siap mengambil job. */
  ready(): Promise<void>;
  /** Berhenti mengambil job baru, menunggu pekerjaan yang sedang berjalan, lalu menutup worker. */
  close(): Promise<void>;
}

/**
 * Mendaftarkan semua worker. Dipisah dari worker.ts supaya bisa dijalankan di test tanpa
 * efek samping tingkat proses (penanganan sinyal, process.exit). Koneksi tidak ditutup di
 * sini: pemiliknya yang menutup, setelah `close()`.
 */
export function startWorkers(connection: ConnectionOptions, options: StartWorkersOptions = {}): StartedWorkers {
  const { prefix, inbound: inboundOptions, outbound: outboundOptions, scheduled: scheduledOptions } = options;
  const withPrefix = prefix ? { prefix } : {};

  const inbound = createInboundWorker(connection, { ...inboundOptions, ...withPrefix });
  const outbound = createOutboundWorker(connection, { ...outboundOptions, ...withPrefix });
  const scheduled = createScheduledWorker(connection, { ...scheduledOptions, ...withPrefix });

  return {
    inbound,
    outbound,
    scheduled,
    ready: async () => {
      await Promise.all([inbound.waitUntilReady(), outbound.waitUntilReady(), scheduled.waitUntilReady()]);
    },
    close: async () => {
      // allSettled: kegagalan menutup satu worker tidak boleh menahan yang lain.
      await Promise.allSettled([inbound.close(), outbound.close(), scheduled.close()]);
    },
  };
}
