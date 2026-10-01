import type { RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { CategoriesService } from './categories.service.js';
import type { ListCategoriesQuery } from './categories.types.js';

export function createCategoriesController(service: CategoriesService) {
  return {
    // `validate` sudah mengganti req.query dengan hasil parse listCategoriesQuerySchema.
    list: (async (req, res) => {
      const { type } = req.query as ListCategoriesQuery;
      sendOk(res, await service.list(requireUser(req).id, type));
    }) satisfies RequestHandler,
  };
}
