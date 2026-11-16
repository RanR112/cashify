import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { auditLogListSchema, listAuditLogsQuerySchema } from './audit-logs.schema.js';

const TAG = 'Audit';

registerRoute({
  method: 'get',
  path: '/audit-logs',
  tag: TAG,
  summary: 'Riwayat audit',
  description:
    'Riwayat perubahan milik pemanggil, terbaru dulu (`created_at DESC, id DESC`). Hanya baris dengan ' +
    '`user_id` pemanggil yang terlihat. `id`, `user_id`, dan `ip_address` tidak pernah ditampilkan; `id` ' +
    'hanya dipakai di cursor opak. `changes` disaring allowlist per jenis entitas, dan bentuk ' +
    '`{ before, after }` dipertahankan. Paginasi memakai cursor, bukan offset.',
  auth: 'jwt',
  request: { query: listAuditLogsQuerySchema },
  responses: { 200: jsonResponse('Satu halaman riwayat audit.', auditLogListSchema) },
});