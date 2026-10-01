import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createUsersController } from './users.controller.js';
import { updateMeBodySchema } from './users.schema.js';
import type { UsersService } from './users.service.js';

/** Dipasang di `/me`. `verifyAuth` bisa disuntik di test. */
export function createUsersRouter(service: UsersService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createUsersController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', asyncHandler(controller.getMe));
  router.patch('/', validate({ body: updateMeBodySchema }), asyncHandler(controller.updateMe));

  return router;
}
