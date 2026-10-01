import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Pembungkus handler async. Express 5 sudah meneruskan promise yang ditolak ke error
 * handler, jadi pembungkus ini tidak lagi wajib; dipertahankan supaya handler memakai
 * satu bentuk yang sama dan pengecualian sinkron maupun async lewat jalur yang sama.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}
