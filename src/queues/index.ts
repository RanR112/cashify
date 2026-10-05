import type { Queue, ConnectionOptions } from 'bullmq';
import {
  createInboundQueue,
  INBOUND_QUEUE,
  type InboundJobData,
  type QueueFactoryOptions,
} from './inbound.queue.js';
import { createOutboundQueue, OUTBOUND_QUEUE, type OutboundJobData } from './outbound.queue.js';

export * from './inbound.queue.js';
export * from './outbound.queue.js';

export const QUEUE_NAMES = { inbound: INBOUND_QUEUE, outbound: OUTBOUND_QUEUE } as const;

export interface Queues {
  inbound: Queue<InboundJobData>;
  outbound: Queue<OutboundJobData>;
}

export function createQueues(connection: ConnectionOptions, options: QueueFactoryOptions = {}): Queues {
  return {
    inbound: createInboundQueue(connection, options),
    outbound: createOutboundQueue(connection, options),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([queues.inbound.close(), queues.outbound.close()]);
}

let shared: Promise<{ queues: Queues; connection: { quit(): Promise<unknown> } }> | undefined;

/**
 * Antrean bersama untuk produsen di proses API (mis. controller webhook yang memasukkan job
 * inbound). Dibuat saat dipakai pertama kali: konfigurasi Redis dimuat dengan impor dinamis
 * karena env.ts memanggil process.exit bila variabel hilang, dan mengimpor berkas ini (juga
 * di test) tidak boleh memicunya.
 */
export async function getQueues(): Promise<Queues> {
  shared ??= import('../config/redis.js').then(({ createBullConnection }) => {
    const connection = createBullConnection();
    return { queues: createQueues(connection), connection };
  });
  return (await shared).queues;
}

/** Menutup antrean bersama beserta koneksinya (BullMQ tidak menutup koneksi yang disuntik). */
export async function closeSharedQueues(): Promise<void> {
  if (!shared) return;
  const { queues, connection } = await shared;
  shared = undefined;
  await closeQueues(queues);
  await connection.quit();
}
