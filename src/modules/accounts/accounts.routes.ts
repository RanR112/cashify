import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createAccountsController } from './accounts.controller.js';
import type { AccountsService } from './accounts.service.js';

/** Dipasang di `/accounts`. `verifyAuth` bisa disuntik di test. */
export function createAccountsRouter(service: AccountsService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createAccountsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', asyncHandler(controller.list));

  return router;
}
