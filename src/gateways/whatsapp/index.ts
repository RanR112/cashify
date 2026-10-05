import { createOpenWaGateway } from './openwa.gateway.js';
import type { WhatsAppGateway } from './whatsapp.gateway.js';

export type { WhatsAppGateway, WhatsAppStatus } from './whatsapp.gateway.js';
export { createMockGateway, type MockWhatsAppGateway } from './mock.gateway.js';
export { createOpenWaGateway } from './openwa.gateway.js';

/** Gateway asli dari variabel lingkungan. Dipanggil di composition root (app.ts, worker.ts). */
export function createGatewayFromEnv(env: { OPENWA_URL: string; OPENWA_API_KEY: string }): WhatsAppGateway {
  return createOpenWaGateway({ baseUrl: env.OPENWA_URL, apiKey: env.OPENWA_API_KEY });
}
