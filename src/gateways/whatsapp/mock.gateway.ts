// Gateway palsu untuk test dan pengembangan tanpa sesi WhatsApp aktif. Tanpa ini, test akan
// mengirim pesan sungguhan atau butuh OpenWA hidup.

import type { WhatsAppGateway, WhatsAppStatus } from './whatsapp.gateway.js';

export interface SentMessage {
  to: string;
  body: string;
}

export interface MockWhatsAppGateway extends WhatsAppGateway {
  /** Semua pesan yang berhasil "terkirim", urut kirim. */
  readonly sent: SentMessage[];
  setConnected(connected: boolean): void;
  /** `sendText` berikutnya (sekali saja) melempar. */
  failNextSend(error?: Error): void;
  reset(): void;
}

export function createMockGateway(): MockWhatsAppGateway {
  const sent: SentMessage[] = [];
  let connected = true;
  let nextError: Error | undefined;

  return {
    sent,

    async sendText(to, body) {
      if (nextError) {
        const error = nextError;
        nextError = undefined;
        throw error;
      }
      sent.push({ to, body });
    },

    async getStatus(): Promise<WhatsAppStatus> {
      return connected ? { connected: true } : { connected: false, detail: 'mock: terputus' };
    },

    setConnected(value) {
      connected = value;
    },

    failNextSend(error = new Error('mock: pengiriman gagal')) {
      nextError = error;
    },

    reset() {
      sent.length = 0;
      connected = true;
      nextError = undefined;
    },
  };
}
