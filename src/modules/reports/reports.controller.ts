import type { RequestHandler } from 'express';
import { requireUser } from '../../shared/utils/requestUser.js';
import { sendOk } from '../../shared/utils/response.js';
import type { ReportsService } from './reports.service.js';
import type { MonthlyReportQuery, TrendReportQuery } from './reports.types.js';

export function createReportsController(service: ReportsService) {
  return {
    // `validate` sudah mengganti query dengan hasil parse skemanya.
    monthly: (async (req, res) => {
      const { id } = requireUser(req);
      sendOk(res, await service.monthly(id, req.query as MonthlyReportQuery));
    }) satisfies RequestHandler,

    trend: (async (req, res) => {
      const { id } = requireUser(req);
      sendOk(res, await service.trend(id, req.query as unknown as TrendReportQuery));
    }) satisfies RequestHandler,
  };
}
