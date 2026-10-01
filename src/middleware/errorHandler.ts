import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { AppError, isAppError } from '../shared/errors/AppError.js';
import { buildErrorBody, sendError } from '../shared/utils/response.js';
import { zodErrorMessage, zodIssuesToDetails } from '../shared/utils/zodErrors.js';

/** Error dari body-parser Express: JSON rusak atau terlalu besar. */
function isBodyParserError(error: unknown): error is { type: string; status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as { type: unknown }).type === 'string' &&
    ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported'].includes(
      (error as { type: string }).type,
    )
  );
}

function toAppError(error: unknown): AppError | null {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) {
    return AppError.validation(zodErrorMessage(error), zodIssuesToDetails(error));
  }
  if (isBodyParserError(error)) {
    return AppError.validation(
      error.type === 'entity.too.large' ? 'Body permintaan terlalu besar' : 'Body bukan JSON yang valid',
    );
  }
  return null;
}

/**
 * Pasang paling akhir. Hanya AppError yang sampai ke klien dengan pesannya sendiri;
 * error lain dijawab 500 generik dan dicatat lengkap di server.
 *
 * Yang dicatat hanya error, method, dan path. Body, query, dan nominal tidak pernah
 * masuk log (ARCHITECTURE.md Bagian 15).
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const known = toAppError(error);
  if (known) {
    sendError(res, known);
    return;
  }

  logger.error({ err: error, method: req.method, path: req.path }, 'Kesalahan tak terduga');
  res
    .status(500)
    .json(buildErrorBody({ code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server', details: undefined }));
};
