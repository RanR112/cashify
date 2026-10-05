import express, { Router } from 'express';
import { createVerifyWebhook } from '../../middleware/verifyWebhook.js';
import { rateLimit } from '../../middleware/rateLimiter.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createWebhooksController } from './webhooks.controller.js';
import type { WebhooksDeps } from './webhooks.types.js';

/** Gambar datang sebagai thumbnail (puluhan KB); batas ini hanya menahan body yang absurd. */
export const WEBHOOK_BODY_LIMIT = '2mb';

/**
 * Dipasang di `/webhooks`, dan HARUS dipasang sebelum pembatas laju global dan `express.json`
 * (lihat app.ts): body dibaca mentah di sini, dan respons 429 dari batas global dianggap gagal
 * oleh OpenWA, yang lalu mengirim ulang.
 *
 * Urutan: batas laju, verifikasi rahasia, baru body dibaca. Rahasia salah ditolak tanpa
 * menyentuh body.
 */
export function createWebhooksRouter(deps: WebhooksDeps): Router {
  const controller = createWebhooksController(deps);
  const router = Router();

  router.post(
    '/openwa/:path',
    rateLimit('webhook'),
    createVerifyWebhook(deps.getSecret),
    express.text({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    asyncHandler(controller.handle),
  );

  return router;
}
