// Kontrak webhook OpenWA. Bentuk body BELUM direkam dari instance v4 nyata (spike P0
// belum menghasilkan rekaman), dan CLAUDE.md melarang menulis parser webhook sebelum
// rekamannya ada. Karena itu body hanya didokumentasikan sebagai objek terbuka; skema
// amplop (webhookId, sessionId, event, timestamp) menyusul setelah rekaman ada.

import { z } from '../../shared/openapi/zod.js';

export const webhookParamsSchema = z.object({
  path: z.string().min(1).max(128).openapi({
    description: 'Segmen acak yang tidak bisa ditebak; lapisan pertahanan tambahan selain header rahasia.',
    example: 'a7f2k9m3q1',
  }),
});

export const webhookHeadersSchema = z.object({
  'x-webhook-secret': z.string().min(16).openapi({
    description: 'Dibandingkan dengan `WEBHOOK_SECRET` memakai `crypto.timingSafeEqual`.',
  }),
});

export const webhookBodySchema = z
  .looseObject({})
  .openapi('OpenWaWebhookBody', {
    description:
      'Event OpenWA v4.76.0. Bentuk pastinya menunggu rekaman dari spike P0. Server menyimpan body mentah ' +
      'sebagai string sebelum parsing; `fromMe: true` diabaikan.',
  });
