import { jsonBody, registerRoute } from '../../shared/openapi/registry.js';
import { webhookBodySchema, webhookHeadersSchema, webhookParamsSchema } from './webhooks.schema.js';

registerRoute({
  method: 'post',
  path: '/webhooks/openwa/{path}',
  tag: 'Webhook',
  summary: 'Penerima event OpenWA',
  description:
    'Bukan untuk klien mobile. Dilindungi header rahasia, bukan JWT. Fase sinkron selesai di bawah 100 ms: ' +
    'verifikasi, simpan mentah ke `message_logs` (unique `(session_id, wa_message_id)`), balas 204, masukkan antrean. ' +
    'Kiriman ulang (duplikat) juga dibalas 204 tanpa pemrosesan ulang. Pemrosesan terjadi di worker.',
  auth: 'webhook',
  request: {
    params: webhookParamsSchema,
    headers: webhookHeadersSchema,
    body: jsonBody(webhookBodySchema),
  },
  responses: {
    204: { description: 'Diterima (termasuk duplikat dan event yang diabaikan).' },
  },
});
