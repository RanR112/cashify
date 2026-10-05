// Pemantau sesi bot WhatsApp. Sesi adalah milik sistem, bukan pengguna (ARCHITECTURE.md Bagian 9):
// hasilnya dipakai untuk menjawab 503 saat bot terputus, dan dicatat di `whatsapp_sessions`.
//
// OpenWA v4 tidak mengirim webhook status sesi (LOCAL-MODE.md), jadi statusnya diambil dengan
// polling gateway. Di sini polling dilakukan saat dibutuhkan dan hasilnya disimpan singkat, supaya
// beberapa permintaan OTP beruntun tidak membanjiri OpenWA. Polling berkala dari worker belum ada.

import { logger } from '../../config/logger.js';
import type { WhatsAppGateway } from '../../gateways/whatsapp/whatsapp.gateway.js';
import type { WhatsappRepository } from './whatsapp.types.js';

export const SESSION_STATUS_TTL_MS = 10_000;

export interface SessionMonitor {
  /** Status terbaru (maksimal setua `ttlMs`). Tidak pernah melempar. */
  isConnected(): Promise<boolean>;
}

export interface SessionMonitorOptions {
  gateway: Pick<WhatsAppGateway, 'getStatus'>;
  repository: Pick<WhatsappRepository, 'upsertSession'>;
  /** Boleh fungsi: composition root membacanya dari env saat dipakai, bukan saat dirakit. */
  sessionId: string | (() => string | Promise<string>);
  ttlMs?: number;
  /** Penyuntik jam untuk test. */
  now?: () => number;
}

export function createSessionMonitor(options: SessionMonitorOptions): SessionMonitor {
  const ttlMs = options.ttlMs ?? SESSION_STATUS_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { connected: boolean; at: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  async function refresh(): Promise<boolean> {
    const status = await options.gateway.getStatus();
    cached = { connected: status.connected, at: now() };
    try {
      const sessionId = typeof options.sessionId === 'function' ? await options.sessionId() : options.sessionId;
      await options.repository.upsertSession(
        { sessionId, connected: status.connected, detail: status.detail },
        new Date(cached.at),
      );
    } catch (err) {
      // Mencatat status ke database adalah bonus; jawabannya tetap sah tanpa itu.
      logger.warn({ err }, 'Gagal mencatat status sesi WhatsApp');
    }
    return status.connected;
  }

  return {
    async isConnected() {
      if (cached && now() - cached.at < ttlMs) return cached.connected;
      // Permintaan serentak berbagi satu pemeriksaan.
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
