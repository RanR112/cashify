import type { Request, RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendCreated, sendNoContent, sendOk } from '../../shared/utils/response.js';
import type { TransactionsService } from './transactions.service.js';
import type {
  AuditContext,
  CreateTransactionInput,
  ListTransactionsQuery,
  UpdateTransactionInput,
} from './transactions.types.js';

/** Kolom audit_logs.ip_address bertipe INET; nilai yang bukan IP akan menggagalkan seluruh transaksi. */
function auditContext(req: Request): AuditContext {
  const ip = req.ip?.split('%')[0];
  return { ipAddress: ip && isIpLike(ip) ? ip : null };
}

const isIpLike = (value: string): boolean => /^[0-9a-f:.]+$/i.test(value);

// `validate` sudah mengganti params, query, dan body dengan hasil parse skemanya.
const idOf = (req: Request): string => (req.params as { id: string }).id;

export function createTransactionsController(service: TransactionsService) {
  return {
    list: (async (req, res) => {
      sendOk(res, await service.list(requireUser(req).id, req.query as unknown as ListTransactionsQuery));
    }) satisfies RequestHandler,

    create: (async (req, res) => {
      const body = req.body as CreateTransactionInput;
      sendCreated(res, await service.create(requireUser(req).id, body, auditContext(req)));
    }) satisfies RequestHandler,

    get: (async (req, res) => {
      sendOk(res, await service.get(requireUser(req).id, idOf(req)));
    }) satisfies RequestHandler,

    update: (async (req, res) => {
      const body = req.body as UpdateTransactionInput;
      sendOk(res, await service.update(requireUser(req).id, idOf(req), body, auditContext(req)));
    }) satisfies RequestHandler,

    remove: (async (req, res) => {
      await service.remove(requireUser(req).id, idOf(req), auditContext(req));
      sendNoContent(res);
    }) satisfies RequestHandler,

    restore: (async (req, res) => {
      sendOk(res, await service.restore(requireUser(req).id, idOf(req), auditContext(req)));
    }) satisfies RequestHandler,
  };
}
