import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../shared/errors/AppError.js';
import { zodErrorMessage, zodIssuesToDetails } from '../shared/utils/zodErrors.js';

interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validasi Zod untuk body, query, dan params. Hasil parse (sudah di-coerce, field tak
 * dikenal dibuang) menggantikan nilai aslinya, sehingga handler hanya melihat data valid.
 *
 * Semua bagian divalidasi sekaligus agar klien mendapat seluruh masalah dalam satu respons.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const parsed: Partial<Record<keyof ValidationSchemas, unknown>> = {};
    let firstMessage: string | undefined;

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        firstMessage ??= zodErrorMessage(result.error);
        details.push(...zodIssuesToDetails(result.error));
      }
    }

    if (details.length > 0) {
      next(AppError.validation(firstMessage ?? 'Input tidak valid', details));
      return;
    }

    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('body' in parsed) req.body = parsed.body;
    // Express 5: req.query adalah getter read-only, jadi ditimpa lewat defineProperty.
    if ('query' in parsed) {
      Object.defineProperty(req, 'query', {
        value: parsed.query,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  };
}
