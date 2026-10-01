import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/AppError.js';

/** Pasang setelah semua route, sebelum errorHandler. */
export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Endpoint ${req.method} ${req.path} tidak ditemukan`));
};
