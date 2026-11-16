import type { Request, RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { ListNotificationsQuery, NotificationsService } from './notifications.types.js';

// `validate` sudah mengganti params dan query dengan hasil parse skemanya.
const idOf = (req: Request): string => (req.params as { id: string }).id;

export function createNotificationsController(service: NotificationsService) {
  return {
    list: (async (req, res) => {
      sendOk(res, await service.list(requireUser(req).id, req.query as unknown as ListNotificationsQuery));
    }) satisfies RequestHandler,

    markRead: (async (req, res) => {
      sendOk(res, await service.markRead(requireUser(req).id, idOf(req)));
    }) satisfies RequestHandler,
  };
}
