import type { Request, RequestHandler } from 'express';
import { AppError } from '../../shared/errors/AppError.js';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { DashboardService } from './dashboard.service.js';
import type { DashboardQuery } from './dashboard.types.js';

/** Profil (untuk saldo awal) dibaca lewat service users yang butuh email dari klaim JWT. */
function identity(req: Request): { userId: string; email: string } {
  const { id, email } = requireUser(req);
  if (!email) throw AppError.unauthorized('Token tidak memuat email');
  return { userId: id, email };
}

export function createDashboardController(service: DashboardService) {
  return {
    // `validate` sudah mengganti query dengan hasil parse skemanya.
    get: (async (req, res) => {
      const { userId, email } = identity(req);
      sendOk(res, await service.get(userId, email, req.query as DashboardQuery));
    }) satisfies RequestHandler,
  };
}
