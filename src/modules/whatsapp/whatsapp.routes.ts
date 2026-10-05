import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createWhatsappController } from './whatsapp.controller.js';
import { linkRequestBodySchema, linkVerifyBodySchema, preferencesBodySchema } from './whatsapp.schema.js';
import type { WhatsappService } from './whatsapp.service.js';

/**
 * Dipasang di `/whatsapp`. `verifyAuth` bisa disuntik di test.
 * Batas 3/nomor/hari dan 5/pengguna/hari ada di service (dihitung dari baris OTP di database),
 * bukan di middleware: tahan restart dan menghitung OTP yang benar-benar dikirim.
 */
export function createWhatsappRouter(service: WhatsappService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createWhatsappController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/status', asyncHandler(controller.getStatus));
  router.post('/link/request', validate({ body: linkRequestBodySchema }), asyncHandler(controller.requestLink));
  router.post('/link/verify', validate({ body: linkVerifyBodySchema }), asyncHandler(controller.verifyLink));
  router.post('/link/resend', asyncHandler(controller.resendLink));
  router.delete('/link', asyncHandler(controller.unlink));
  router.patch('/preferences', validate({ body: preferencesBodySchema }), asyncHandler(controller.updatePreferences));

  return router;
}
