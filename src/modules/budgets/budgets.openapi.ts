import { jsonBody, jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { idParamsSchema } from '../../shared/schemas/common.schema.js';
import {
  budgetDetailSchema,
  budgetListQuerySchema,
  budgetListSchema,
  budgetSchema,
  createBudgetBodySchema,
  updateBudgetBodySchema,
} from './budgets.schema.js';

const TAG = 'Anggaran';

registerRoute({
  method: 'get',
  path: '/budgets',
  tag: TAG,
  summary: 'Daftar anggaran',
  description:
    'Anggaran milik pemanggil, urut `period_start` menurun. `status=active` menyaring periode yang memuat ' +
    'hari ini menurut Asia/Jakarta; bawaan `all` agar riwayat tidak hilang. Tanpa progres dan tanpa cursor.',
  auth: 'jwt',
  request: { query: budgetListQuerySchema },
  responses: { 200: jsonResponse('Daftar anggaran.', budgetListSchema) },
});

registerRoute({
  method: 'get',
  path: '/budgets/current',
  tag: TAG,
  summary: 'Anggaran aktif',
  description:
    'Anggaran yang periodenya memuat hari ini (Asia/Jakarta). Karena satu pengguna hanya boleh punya ' +
    'satu anggaran aktif, tidak ada ambiguitas antara monthly dan weekly.',
  auth: 'jwt',
  responses: { 200: jsonResponse('Anggaran aktif beserta progresnya.', budgetDetailSchema) },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'get',
  path: '/budgets/{id}',
  tag: TAG,
  summary: 'Detail anggaran',
  description:
    'Anggaran beserta progres yang dihitung saat diminta. `spent_total` mencakup seluruh pengeluaran periode, ' +
    'termasuk kategori yang tidak dialokasikan; `spent` per kategori hanya untuk kategori yang dialokasikan.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 200: jsonResponse('Anggaran beserta progresnya.', budgetDetailSchema) },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'post',
  path: '/budgets',
  tag: TAG,
  summary: 'Buat anggaran',
  description:
    'Server menormalkan `period_start` ke awal periode (monthly: tanggal 1; weekly: Senin) dan menghitung ' +
    '`period_end` (akhir bulan; Minggu). Periode tidak boleh beririsan dengan anggaran lain milik pengguna, ' +
    'apa pun `period_type`-nya. Kategori harus pengeluaran dan terlihat pengguna; jumlah alokasi tidak boleh ' +
    'melebihi `total_amount`. `rollover_enabled` disimpan tanpa efek.',
  auth: 'jwt',
  request: { body: jsonBody(createBudgetBodySchema) },
  responses: { 201: jsonResponse('Anggaran dibuat.', budgetSchema) },
  errors: ['NOT_FOUND', 'CONFLICT'],
});

registerRoute({
  method: 'patch',
  path: '/budgets/{id}',
  tag: TAG,
  summary: 'Ubah anggaran',
  description:
    'Body sebagian; minimal satu field. `period_type`, `period_start`, dan `period_end` tidak boleh diubah. ' +
    '`categories` bersifat upsert per `category_id` dan menghapus yang tidak dikirim; `alert_sent_at` ' +
    'dipertahankan bila `amount` dan `alert_threshold` tidak berubah. Tidak ada optimistic locking.',
  auth: 'jwt',
  request: { params: idParamsSchema, body: jsonBody(updateBudgetBodySchema) },
  responses: { 200: jsonResponse('Anggaran setelah perubahan.', budgetSchema) },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'delete',
  path: '/budgets/{id}',
  tag: TAG,
  summary: 'Hapus anggaran',
  description: 'Soft delete (`deleted_at`). Anggaran yang sudah dihapus tidak muncul di daftar dan membebaskan periode untuk anggaran baru.',
  auth: 'jwt',
  request: { params: idParamsSchema },
  responses: { 204: { description: 'Anggaran dihapus.' } },
  errors: ['NOT_FOUND'],
});
