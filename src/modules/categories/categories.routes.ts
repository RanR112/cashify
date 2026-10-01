import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createCategoriesController } from './categories.controller.js';
import { listCategoriesQuerySchema } from './categories.schema.js';
import type { CategoriesService } from './categories.service.js';

/** Dipasang di `/categories`. `verifyAuth` bisa disuntik di test. */
export function createCategoriesRouter(
  service: CategoriesService,
  verifyAuth: RequestHandler = authenticate,
): Router {
  const controller = createCategoriesController(service);
  const router = Router();

  router.use(verifyAuth);
  router.get('/', validate({ query: listCategoriesQuerySchema }), asyncHandler(controller.list));

  return router;
}
