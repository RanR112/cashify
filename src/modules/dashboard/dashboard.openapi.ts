import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { dashboardQuerySchema, dashboardResponseSchema } from './dashboard.schema.js';

registerRoute({
  method: 'get',
  path: '/dashboard',
  tag: 'Dashboard',
  summary: 'Ringkasan beranda',
  description:
    'Sengaja menggabungkan beberapa kueri menjadi satu respons: empat panggilan berurutan di 4G yang buruk ' +
    'terasa jauh lebih lambat daripada satu panggilan yang sedikit lebih besar.',
  auth: 'jwt',
  request: { query: dashboardQuerySchema },
  responses: { 200: jsonResponse('Ringkasan bulan yang diminta.', dashboardResponseSchema) },
});
