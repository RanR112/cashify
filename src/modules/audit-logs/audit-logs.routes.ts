import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createAuditLogsController } from './audit-logs.controller.js';
import { listAuditLogsQuerySchema } from './audit-logs.schema.js';
import type { AuditLogsService } from './audit-logs.service.js';

/** Dipasang di `/audit-logs`. `verifyAuth` bisa disuntik di test. */
export function createAuditLogsRouter(service: AuditLogsService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createAuditLogsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: listAuditLogsQuerySchema }), asyncHandler(controller.list));

  return router;
}