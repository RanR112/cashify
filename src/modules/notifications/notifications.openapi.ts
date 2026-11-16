import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import {
  listNotificationsQuerySchema,
  notificationListSchema,
  notificationSchema,
} from './notifications.schema.js';

const TAG = 'Notifikasi';

registerRoute({
  method: 'get',
  path: '/notifications',
  tag: TAG,
  summary: 'Riwayat notifikasi',
  description:
    'Notifikasi milik pemanggil, terbaru dulu (`created_at DESC, id DESC`). Paginasi cursor, bukan offset, ' +
    'karena daftar terus bertambah di bagian atas. `payload` tidak ditampilkan karena hanya memuat id internal ' +
    'dan tanggal. Riwayat tidak pernah dihapus (tidak ada soft delete).',
  auth: 'jwt',
  request: { query: listNotificationsQuerySchema },
  responses: { 200: jsonResponse('Satu halaman notifikasi.', notificationListSchema) },
});

registerRoute({
  method: 'patch',
  path: '/notifications/{id}/read',
  tag: TAG,
  summary: 'Tandai notifikasi sudah dibaca',
  description:
    'Hanya berlaku dari status `sent`; `read` yang diulang tetap 200 dan `sent_at` dipertahankan. ' +
    'Status `pending` atau `failed` dijawab 409 karena pesan belum/tidak akan tiba. Notifikasi milik ' +
    'pengguna lain dijawab 404, bukan 403.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 200: jsonResponse('Notifikasi dengan status `read`.', notificationSchema) },
  errors: ['NOT_FOUND', 'CONFLICT'],
});
