import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createBudgetsController } from './budgets.controller.js';
import {
  budgetListQuerySchema,
  createBudgetBodySchema,
  updateBudgetBodySchema,
} from './budgets.schema.js';
import type { BudgetsService } from './budgets.service.js';

/** Dipasang di `/budgets`. `verifyAuth` bisa disuntik di test. */
export function createBudgetsRouter(service: BudgetsService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createBudgetsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: budgetListQuerySchema }), asyncHandler(controller.list));
  router.post('/', validate({ body: createBudgetBodySchema }), asyncHandler(controller.create));

  // `/current` harus didaftarkan sebelum `/:id`, kalau tidak "current" dianggap UUID.
  router.get('/current', asyncHandler(controller.current));
  router.get('/:id', validate({ params: idParamsSchema }), asyncHandler(controller.get));
  router.patch(
    '/:id',
    validate({ params: idParamsSchema, body: updateBudgetBodySchema }),
    asyncHandler(controller.update),
  );
  router.delete('/:id', validate({ params: idParamsSchema }), asyncHandler(controller.remove));

  return router;
}
