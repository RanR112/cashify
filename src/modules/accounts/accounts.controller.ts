import type { RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { AccountsService } from './accounts.service.js';

export function createAccountsController(service: AccountsService) {
  return {
    list: (async (req, res) => {
      sendOk(res, await service.list(requireUser(req).id));
    }) satisfies RequestHandler,
  };
}
