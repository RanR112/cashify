// Registry OpenAPI tunggal dan pembungkus pendaftaran endpoint. Setiap modul punya
// berkas `<nama>.openapi.ts` yang memanggil `registerRoute`; `config/openapi.ts`
// mengimpor semuanya dan membangun dokumen.

import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { ERROR_STATUS, type ErrorCode } from '../constants/errorCodes.js';
import { errorResponseSchema } from '../schemas/common.schema.js';

export const registry = new OpenAPIRegistry();

export type AuthKind = 'jwt' | 'webhook' | 'none';

const ERROR_DESCRIPTION: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Input tidak valid (VALIDATION_ERROR).',
  UNAUTHORIZED: 'Kredensial tidak ada, tidak valid, atau kedaluwarsa (UNAUTHORIZED).',
  FORBIDDEN: 'Tidak berhak mengakses sumber daya ini (FORBIDDEN).',
  NOT_FOUND: 'Sumber daya tidak ditemukan (NOT_FOUND).',
  CONFLICT: 'Bentrok dengan keadaan saat ini (CONFLICT).',
  RATE_LIMITED: 'Batas permintaan terlampaui (RATE_LIMITED).',
  INTERNAL_ERROR: 'Kesalahan server (INTERNAL_ERROR).',
  SERVICE_UNAVAILABLE: 'Layanan sementara tidak tersedia (SERVICE_UNAVAILABLE).',
};

const SECURITY: Record<AuthKind, NonNullable<RouteConfig['security']>> = {
  jwt: [{ bearerAuth: [] }],
  // Rahasia webhook ada di segmen path, yang tidak punya padanan di skema keamanan OpenAPI;
  // dijelaskan di deskripsi endpoint.
  webhook: [],
  none: [],
};

type ApiRoute = Omit<RouteConfig, 'security' | 'tags' | 'summary'> & {
  tag: string;
  summary: string;
  auth: AuthKind;
  /**
   * Kode error yang bisa dikembalikan endpoint ini. Ditambah otomatis:
   * VALIDATION_ERROR bila ada request, UNAUTHORIZED bila auth bukan 'none',
   * INTERNAL_ERROR selalu.
   */
  errors?: ErrorCode[];
};

export function registerRoute({ tag, summary, auth, errors = [], ...route }: ApiRoute): void {
  const codes = new Set<ErrorCode>(errors);
  if (route.request) codes.add('VALIDATION_ERROR');
  if (auth !== 'none') codes.add('UNAUTHORIZED');
  codes.add('INTERNAL_ERROR');

  const errorResponses = Object.fromEntries(
    [...codes]
      .sort((a, b) => ERROR_STATUS[a] - ERROR_STATUS[b])
      .map((code) => [
        String(ERROR_STATUS[code]),
        {
          description: ERROR_DESCRIPTION[code],
          content: { 'application/json': { schema: errorResponseSchema } },
        },
      ]),
  );

  registry.registerPath({
    ...route,
    summary,
    tags: [tag],
    security: SECURITY[auth],
    responses: { ...route.responses, ...errorResponses },
  });
}

/** Helper untuk `responses`: body JSON dengan skema tertentu. */
export function jsonResponse(description: string, schema: Parameters<typeof registry.register>[1]) {
  return { description, content: { 'application/json': { schema } } };
}

export function jsonBody(schema: Parameters<typeof registry.register>[1]) {
  return { required: true, content: { 'application/json': { schema } } };
}
