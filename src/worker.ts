// Entry point worker: proses terpisah dari API (src/server.ts), basis kode yang sama.
// Pemrosesan pesan masuk dan pengiriman balasan terjadi di sini agar yang lambat tidak pernah
// menahan respons HTTP (aturan 4).
//
// JALANKAN SATU INSTANCE SAJA. Antrean `outbound` harus ter-throttle secara global; dua proses
// worker berarti dua kali laju kirim, dan itu yang membuat nomor bot diblokir (aturan 12).
//
// Berhenti bersih: SIGTERM/SIGINT berhenti mengambil job baru, menunggu pekerjaan yang sedang
// berjalan, menutup koneksi, lalu keluar 0. Bila macet lebih dari 15 detik, keluar 1.
// Catatan Windows: Node di Windows tidak menjalankan handler SIGTERM (proses langsung dimatikan);
// di sana hanya Ctrl+C (SIGINT) di konsol yang berhenti bersih. Di Linux/macOS keduanya berlaku.

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createBullConnection, createRedisClient } from './config/redis.js';
import { createGatewayFromEnv } from './gateways/whatsapp/index.js';
import { getPrisma } from './lib/database.js';
import { createOutboundQueue, enqueueOutbound, QUEUE_NAMES } from './queues/index.js';
import { startWorkers } from './workers/index.js';
import { createInboundPipeline } from './workers/pipeline.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

const connection = createBullConnection(env.REDIS_URL);
// Satu-satunya jalur kirim WhatsApp: worker outbound memanggil gateway, dengan concurrency 1 dan
// jeda acak 2-5 detik (aturan 12). Gagal kirim melempar, sehingga BullMQ mencoba ulang.
const gateway = createGatewayFromEnv(env);

// Pemroses pesan masuk menaruh balasannya ke antrean outbound (bukan memanggil gateway): yang
// mengirim tetap worker outbound di bawah. Klien helper terpisah dari koneksi BullMQ karena
// kebutuhannya berlawanan (gagal cepat, lihat config/redis.ts).
const helperRedis = createRedisClient(env.REDIS_URL);
const replyQueue = createOutboundQueue(connection);
const pipeline = createInboundPipeline({
  prisma: getPrisma(),
  redis: helperRedis,
  enqueueReply: (request) =>
    enqueueOutbound(
      replyQueue,
      { wa_chat_id: request.to, text: request.text, message_log_id: request.messageLogId },
      // Satu balasan per pesan: job inbound yang diulang tidak menggandakannya.
      { jobId: `reply-${request.messageLogId}` },
    ),
});

const workers = startWorkers(connection, {
  inbound: { processor: pipeline.processor, onExhausted: pipeline.markInboundFailed },
  outbound: {
    send: (data) => gateway.sendText(data.wa_chat_id, data.text),
    // Sesi terputus: job ditunda, bukan digugurkan (outbound.worker.ts).
    isConnected: async () => (await gateway.getStatus()).connected,
    onExhausted: pipeline.recordReplyFailure,
  },
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  // Sinyal kedua (atau galat saat berhenti) tidak memulai penutupan kedua.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Worker berhenti: menunggu pekerjaan yang sedang berjalan');

  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Worker tidak berhenti tepat waktu, dipaksa keluar');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let code = exitCode;
  try {
    await workers.close();
    await replyQueue.close();
    await helperRedis.quit();
    await connection.quit();
    logger.info('Worker berhenti bersih');
  } catch (err) {
    logger.error({ err }, 'Gagal menutup worker dengan bersih');
    code = 1;
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandledRejection');
  void shutdown('unhandledRejection', 1);
});

workers
  .ready()
  .then(() => logger.info({ queues: Object.values(QUEUE_NAMES), redis: 'tersambung' }, 'Worker siap'))
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Worker gagal start');
    void shutdown('startup-error', 1);
  });
