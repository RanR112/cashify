import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createTransactionsController } from './transactions.controller.js';
import {
  createTransactionBodySchema,
  listTransactionsQuerySchema,
  updateTransactionBodySchema,
} from './transactions.schema.js';
import type { TransactionsService } from './transactions.service.js';

/** Dipasang di `/transactions`. `verifyAuth` bisa disuntik di test. */
export function createTransactionsRouter(
  service: TransactionsService,
  verifyAuth: RequestHandler = authenticate,
): Router {
  const controller = createTransactionsController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: listTransactionsQuerySchema }), asyncHandler(controller.list));
  // Pembatas laju dipasang setelah verifyAuth karena kuncinya adalah id pengguna.
  router.post(
    '/',
    rateLimit('createTransaction'),
    validate({ body: createTransactionBodySchema }),
    asyncHandler(controller.create),
  );
  router.get('/:id', validate({ params: idParamsSchema }), asyncHandler(controller.get));
  router.patch(
    '/:id',
    validate({ params: idParamsSchema, body: updateTransactionBodySchema }),
    asyncHandler(controller.update),
  );
  router.delete('/:id', validate({ params: idParamsSchema }), asyncHandler(controller.remove));
  router.post('/:id/restore', validate({ params: idParamsSchema }), asyncHandler(controller.restore));

  return router;
}
