// Antrean `inbound`: pesan WhatsApp yang sudah tersimpan mentah di message_logs dan menunggu
// diproses. Controller webhook hanya memasukkan ID ke sini (aturan 4); pemrosesan terjadi di
// worker. Hanya ID yang dikirim, bukan payload: sumber kebenaran tetap di database.
//
// Tidak mengimpor config/env: koneksi disuntik, jadi berkas ini bisa diuji sendirian.

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';

export const INBOUND_QUEUE = 'inbound';

/**
 * Pesan satu pengguna diurutkan oleh lock per pengguna (lib/userLock.ts), bukan oleh antrean,
 * sehingga pengguna berbeda boleh diproses paralel. Default BullMQ adalah 1, yang bukan
 * "normal". Ubah di sini saja.
 */
export const INBOUND_CONCURRENCY = 5;

export const inboundJobSchema = z.object({ message_log_id: z.uuid() });
export type InboundJobData = z.infer<typeof inboundJobSchema>;

export const INBOUND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const satisfies JobsOptions;

export interface QueueFactoryOptions {
  /** Awalan kunci Redis; bawaan BullMQ. Test memakai awalan unik supaya tidak saling mengganggu. */
  prefix?: string;
}

export function createInboundQueue(
  connection: ConnectionOptions,
  { prefix }: QueueFactoryOptions = {},
): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE, {
    connection,
    defaultJobOptions: INBOUND_JOB_OPTIONS,
    ...(prefix && { prefix }),
  });
}

/**
 * `jobId` = id pesan: memasukkan pesan yang sama dua kali tidak menghasilkan dua job. Idempotency
 * sebenarnya dijamin unique index message_logs; ini lapisan tambahan yang murah.
 */
export async function enqueueInbound(queue: Queue<InboundJobData>, data: InboundJobData) {
  // `async`: data yang salah menjadi promise yang ditolak, bukan galat sinkron.
  const parsed = inboundJobSchema.parse(data);
  return queue.add('process-message', parsed, { jobId: parsed.message_log_id });
}
