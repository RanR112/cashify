import type { Request, RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { AuditLogsService } from './audit-logs.service.js';
import type { ListAuditLogsQuery } from './audit-logs.types.js';

export function createAuditLogsController(service: AuditLogsService) {
  return {
    // `validate` sudah mengganti query dengan hasil parse skemanya.
    list: (async (req: Request, res) => {
      sendOk(res, await service.list(requireUser(req).id, req.query as unknown as ListAuditLogsQuery));
    }) satisfies RequestHandler,
  };
}