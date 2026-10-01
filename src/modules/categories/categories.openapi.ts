import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { listCategoriesQuerySchema, listCategoriesResponseSchema } from './categories.schema.js';

registerRoute({
  method: 'get',
  path: '/categories',
  tag: 'Kategori',
  summary: 'Daftar kategori',
  description:
    'Kategori sistem (7 pengeluaran, 5 pemasukan) ditambah kategori milik pengguna. ' +
    'Register menyalin kategori sistem menjadi milik pengguna, jadi per slug hanya satu yang tampil ' +
    'dan salinan milik pengguna menang (`is_system` false). Kategori kustom belum bisa dibuat di cakupan ini.',
  auth: 'jwt',
  request: { query: listCategoriesQuerySchema },
  responses: { 200: jsonResponse('Daftar kategori, terurut menurut `sort_order`.', listCategoriesResponseSchema) },
});
