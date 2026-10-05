// Implementasi WhatsAppGateway untuk OpenWA 4.76.0 (Easy API v4). Satu-satunya berkas yang tahu
// bentuk HTTP-nya.
//
// Terverifikasi di spike P0: POST {base}/sendText dengan body {"args":{"to","content"}}.
// ASUMSI yang belum direkam dari instance nyata (periksa di http://localhost:8002/api-docs):
//  - header autentikasi bernama `api_key` (nilai flag -k OpenWA);
//  - POST {base}/getConnectionState dengan body {"args":{}} menjawab {"success":true,"response":"CONNECTED"};
//  - bentuk amplop galat `{"success":false,...}`.
// Karena itu status dibaca longgar: hanya "CONNECTED" yang dianggap terhubung, jawaban lain atau
// gangguan jaringan berarti terputus. Aman salah ke arah terputus (503), bukan ke arah terhubung.
//
// Isi pesan memuat kode OTP, jadi tidak pernah dimasukkan ke pesan galat.

import { z } from 'zod';
import { maskPhoneForLog } from '../../shared/utils/phone.js';
import type { WhatsAppGateway, WhatsAppStatus } from './whatsapp.gateway.js';

const DEFAULT_TIMEOUT_MS = 10_000;

const envelopeSchema = z.object({ success: z.boolean(), response: z.unknown().optional() });

const CONNECTED = 'CONNECTED';

export interface OpenWaGatewayOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Disuntik di test; bawaannya fetch global Node. */
  fetch?: typeof fetch;
}

export function createOpenWaGateway(options: OpenWaGatewayOptions): WhatsAppGateway {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  async function call(path: string, args: Record<string, unknown>): Promise<z.infer<typeof envelopeSchema>> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', api_key: options.apiKey },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenWA ${path} membalas HTTP ${res.status}`);
    const parsed = envelopeSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`OpenWA ${path} membalas bentuk yang tidak dikenal`);
    return parsed.data;
  }

  return {
    async sendText(to, body) {
      let envelope: z.infer<typeof envelopeSchema>;
      try {
        envelope = await call('/sendText', { to, content: body });
      } catch (error) {
        // Pesan galat aslinya (bisa memuat URL) cukup; isi pesan tidak ikut.
        throw new Error(`Gagal mengirim ke ${maskPhoneForLog(to)}: ${(error as Error).message}`, { cause: error });
      }
      if (!envelope.success) throw new Error(`OpenWA menolak pengiriman ke ${maskPhoneForLog(to)}`);
    },

    async getStatus(): Promise<WhatsAppStatus> {
      try {
        const envelope = await call('/getConnectionState', {});
        if (envelope.success && envelope.response === CONNECTED) return { connected: true };
        return { connected: false, detail: `status sesi: ${String(envelope.response ?? 'tidak diketahui')}` };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },
  };
}
