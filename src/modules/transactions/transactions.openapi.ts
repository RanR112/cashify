import { jsonBody, jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import {
  createTransactionBodySchema,
  listTransactionsQuerySchema,
  transactionDetailSchema,
  transactionListSchema,
  transactionSchema,
  updateTransactionBodySchema,
} from './transactions.schema.js';

const TAG = 'Transaksi';

registerRoute({
  method: 'get',
  path: '/transactions',
  tag: TAG,
  summary: 'Daftar transaksi',
  description:
    'Terurut menurun menurut tanggal. Paginasi cursor, bukan offset: daftar terus bertambah di bagian atas, ' +
    'sehingga offset menghasilkan baris terlewat atau ganda saat pengguna menggulir. Transaksi yang sudah dihapus tidak ditampilkan.',
  auth: 'jwt',
  request: { query: listTransactionsQuerySchema },
  responses: { 200: jsonResponse('Satu halaman transaksi.', transactionListSchema) },
});

registerRoute({
  method: 'post',
  path: '/transactions',
  tag: TAG,
  summary: 'Buat transaksi',
  description:
    'Rate limit: 60 per menit per pengguna. 404 bila kategori atau akun tidak ditemukan; ' +
    '400 bila tipe kategori tidak cocok dengan tipe transaksi.',
  auth: 'jwt',
  request: { body: jsonBody(createTransactionBodySchema) },
  responses: { 201: jsonResponse('Transaksi dibuat.', transactionSchema) },
  errors: ['NOT_FOUND', 'RATE_LIMITED'],
});

registerRoute({
  method: 'get',
  path: '/transactions/{id}',
  tag: TAG,
  summary: 'Detail transaksi',
  description: 'Menyertakan `source_message` bila transaksi berasal dari WhatsApp.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 200: jsonResponse('Detail transaksi.', transactionDetailSchema) },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'patch',
  path: '/transactions/{id}',
  tag: TAG,
  summary: 'Ubah sebagian field transaksi',
  description:
    'PATCH, bukan PUT, karena klien mengubah sebagian field. `updated_at` wajib dikirim; bila nilainya sudah ' +
    'berubah sejak dibaca (mis. diedit lewat WhatsApp), server membalas 409 dan klien memuat ulang.',
  auth: 'jwt',
  request: { params: idParamsSchema, body: jsonBody(updateTransactionBodySchema) },
  responses: { 200: jsonResponse('Transaksi setelah diubah.', transactionSchema) },
  errors: ['NOT_FOUND', 'CONFLICT'],
});

registerRoute({
  method: 'delete',
  path: '/transactions/{id}',
  tag: TAG,
  summary: 'Hapus transaksi (soft delete)',
  description: 'Mengisi `deleted_at`; data tidak dihapus dan bisa dipulihkan lewat `/restore`.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 204: { description: 'Transaksi dihapus.' } },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'post',
  path: '/transactions/{id}/restore',
  tag: TAG,
  summary: 'Batalkan penghapusan',
  description: '404 bila transaksi tidak ada atau belum dihapus.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 200: jsonResponse('Transaksi dipulihkan.', transactionSchema) },
  errors: ['NOT_FOUND'],
});
