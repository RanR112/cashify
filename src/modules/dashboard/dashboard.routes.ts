import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createDashboardController } from './dashboard.controller.js';
import { dashboardQuerySchema } from './dashboard.schema.js';
import type { DashboardService } from './dashboard.service.js';

/** Dipasang di `/dashboard`. `verifyAuth` bisa disuntik di test. */
export function createDashboardRouter(service: DashboardService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createDashboardController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: dashboardQuerySchema }), asyncHandler(controller.get));

  return router;
}
