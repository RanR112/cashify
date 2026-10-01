// Perakit response. Sukses = objek telanjang tanpa amplop (kontrak di claude/API.md);
// error = bentuk seragam ARCHITECTURE.md Bagian 12.

import type { Response } from 'express';
import type { z } from 'zod';
import type { AppError } from '../errors/AppError.js';
import type { errorResponseSchema } from '../schemas/common.schema.js';

export type ErrorBody = z.infer<typeof errorResponseSchema>;

export function sendOk<T>(res: Response, body: T): void {
  res.status(200).json(body);
}

export function sendCreated<T>(res: Response, body: T): void {
  res.status(201).json(body);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

export function buildErrorBody(error: Pick<AppError, 'code' | 'message' | 'details'>): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details && error.details.length > 0 && { details: error.details }),
    },
  };
}

export function sendError(res: Response, error: AppError): void {
  res.status(error.status).json(buildErrorBody(error));
}
