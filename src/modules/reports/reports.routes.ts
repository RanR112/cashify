import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createReportsController } from './reports.controller.js';
import { monthlyReportQuerySchema, trendReportQuerySchema } from './reports.schema.js';
import type { ReportsService } from './reports.service.js';

/** Dipasang di `/reports`. `verifyAuth` bisa disuntik di test. */
export function createReportsRouter(service: ReportsService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createReportsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/monthly', validate({ query: monthlyReportQuerySchema }), asyncHandler(controller.monthly));
  router.get('/trend', validate({ query: trendReportQuerySchema }), asyncHandler(controller.trend));

  return router;
}
