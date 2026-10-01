// Kode error API. Sumber: claude/ARCHITECTURE.md Bagian 12, ditambah SERVICE_UNAVAILABLE
// untuk kasus sesi bot WhatsApp terputus (Bagian 12 menyebut 503 tanpa memberinya kode).

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<ErrorCode, number>;

export type ErrorStatus = (typeof ERROR_STATUS)[ErrorCode];
