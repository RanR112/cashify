import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createNotificationsController } from './notifications.controller.js';
import { listNotificationsQuerySchema } from './notifications.schema.js';
import type { NotificationsService } from './notifications.types.js';

/** Dipasang di `/notifications`. `verifyAuth` bisa disuntik di test. */
export function createNotificationsRouter(
  service: NotificationsService,
  verifyAuth: RequestHandler = authenticate,
): Router {
  const controller = createNotificationsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: listNotificationsQuerySchema }), asyncHandler(controller.list));
  router.patch('/:id/read', validate({ params: idParamsSchema }), asyncHandler(controller.markRead));

  return router;
}
