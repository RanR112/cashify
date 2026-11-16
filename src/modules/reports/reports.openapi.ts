import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import {
  monthlyReportQuerySchema,
  monthlyReportSchema,
  trendReportQuerySchema,
  trendReportSchema,
} from './reports.schema.js';

const TAG = 'Laporan';

registerRoute({
  method: 'get',
  path: '/reports/monthly',
  tag: TAG,
  summary: 'Laporan bulanan',
  description:
    'Total pemasukan, pengeluaran, rincian per kategori, dan arus kas harian untuk satu bulan. ' +
    'Batas bulan memakai kalender Asia/Jakarta. Hari tanpa transaksi tetap muncul dengan nilai 0, ' +
    'dan bulan di masa depan sah dengan seluruh nilai 0. `percent` dihitung terhadap total tipe ' +
    'yang sama; jumlahnya boleh 99,9-100,1 karena pembulatan.',
  auth: 'jwt',
  request: { query: monthlyReportQuerySchema },
  responses: { 200: jsonResponse('Laporan bulan yang diminta.', monthlyReportSchema) },
});

registerRoute({
  method: 'get',
  path: '/reports/trend',
  tag: TAG,
  summary: 'Tren bulanan',
  description:
    'Pemasukan, pengeluaran, dan selisih selama N bulan terakhir, urut menaik sampai bulan ' +
    'berjalan (Asia/Jakarta). Bulan tanpa transaksi tetap ada dengan nilai 0.',
  auth: 'jwt',
  request: { query: trendReportQuerySchema },
  responses: { 200: jsonResponse('Tren bulanan.', trendReportSchema) },
});
