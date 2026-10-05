import type { RequestHandler } from 'express';
import { sendNoContent, sendOk } from '../../shared/utils/response.js';
import { requireUser } from '../../shared/utils/requestUser.js';
import type { WhatsappService } from './whatsapp.service.js';

// `user_id` hanya dari klaim JWT lewat requireUser (aturan 8); body tidak pernah membawanya.
export function createWhatsappController(service: WhatsappService) {
  return {
    getStatus: (async (req, res) => {
      sendOk(res, await service.getStatus(requireUser(req).id));
    }) satisfies RequestHandler,

    requestLink: (async (req, res) => {
      sendOk(res, await service.requestLink(requireUser(req).id, req.body));
    }) satisfies RequestHandler,

    verifyLink: (async (req, res) => {
      sendOk(res, await service.verifyLink(requireUser(req).id, req.body));
    }) satisfies RequestHandler,

    resendLink: (async (req, res) => {
      sendOk(res, await service.resendLink(requireUser(req).id));
    }) satisfies RequestHandler,

    unlink: (async (req, res) => {
      await service.unlink(requireUser(req).id);
      sendNoContent(res);
    }) satisfies RequestHandler,

    updatePreferences: (async (req, res) => {
      sendOk(res, await service.updatePreferences(requireUser(req).id, req.body));
    }) satisfies RequestHandler,
  };
}
