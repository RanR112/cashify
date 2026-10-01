import { ERROR_STATUS, type ErrorCode } from '../constants/errorCodes.js';

export interface ErrorDetail {
  field?: string;
  issue: string;
  attempts_left?: number;
  retry_after_seconds?: number;
}

/**
 * Error yang boleh sampai ke klien. Kode berasal dari daftar tertutup di errorCodes.ts,
 * status HTTP diturunkan dari kode sehingga keduanya tidak bisa menyimpang.
 * Error lain (bug, kegagalan database) bukan AppError dan dijawab 500 generik.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  static validation(message: string, details?: ErrorDetail[]): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Autentikasi diperlukan'): AppError {
    return new AppError('UNAUTHORIZED', message);
  }

  static forbidden(message = 'Anda tidak berhak mengakses sumber daya ini'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static notFound(message = 'Sumber daya tidak ditemukan'): AppError {
    return new AppError('NOT_FOUND', message);
  }

  static conflict(message: string, details?: ErrorDetail[]): AppError {
    return new AppError('CONFLICT', message, details);
  }

  static rateLimited(retryAfterSeconds: number, message = 'Terlalu banyak permintaan, coba lagi nanti'): AppError {
    return new AppError('RATE_LIMITED', message, [
      { issue: 'rate_limited', retry_after_seconds: retryAfterSeconds },
    ]);
  }

  static unavailable(message: string): AppError {
    return new AppError('SERVICE_UNAVAILABLE', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
