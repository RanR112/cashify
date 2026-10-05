import { jsonBody, registerRoute } from '../../shared/openapi/registry.js';
import { webhookEnvelopeSchema, webhookParamsSchema } from './webhooks.schema.js';

registerRoute({
  method: 'post',
  path: '/webhooks/openwa/{path}',
  tag: 'Webhook',
  summary: 'Penerima event OpenWA',
  description:
    'Bukan untuk klien mobile. Tanpa JWT: rahasia (`WEBHOOK_SECRET`) adalah segmen `{path}`, karena OpenWA v4 tidak ' +
    'bisa mengirim header kustom. Fase sinkron selesai di bawah 100 ms: verifikasi, simpan mentah ke `message_logs` ' +
    '(unique `(session_id, wa_message_id)`), balas 204, masukkan antrean. Hanya `onMessage` yang diproses; ' +
    '`onAnyMessage`, `onAck`, event lain, `fromMe: true`, pesan grup, dan `type: "ciphertext"` dibalas 204 tanpa efek. ' +
    'Kiriman ulang (duplikat) juga dibalas 204 tanpa pemrosesan ulang. Pemrosesan terjadi di worker.',
  auth: 'webhook',
  request: {
    params: webhookParamsSchema,
    body: jsonBody(webhookEnvelopeSchema),
  },
  responses: {
    204: { description: 'Diterima (termasuk duplikat dan event yang diabaikan).' },
  },
});
