import type { Request, RequestHandler } from 'express';
import { AppError } from '../../shared/errors/AppError.js';
import { sendOk } from '../../shared/utils/response.js';
import { requireUser } from '../../shared/utils/requestUser.js';
import type { UsersService } from './users.service.js';

/** Profil memuat email, yang hanya ada di klaim JWT. Token tanpa klaim itu tidak bisa dilayani. */
function identity(req: Request): { userId: string; email: string } {
  const { id, email } = requireUser(req);
  if (!email) throw AppError.unauthorized('Token tidak memuat email');
  return { userId: id, email };
}

export function createUsersController(service: UsersService) {
  return {
    getMe: (async (req, res) => {
      const { userId, email } = identity(req);
      sendOk(res, await service.getMe(userId, email));
    }) satisfies RequestHandler,

    updateMe: (async (req, res) => {
      const { userId, email } = identity(req);
      sendOk(res, await service.updateMe(userId, email, req.body));
    }) satisfies RequestHandler,
  };
}
