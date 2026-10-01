import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startServer, postJson, type TestServer } from '../helpers/http.js';

// logger.ts mengimpor env.ts yang memanggil process.exit bila .env tidak dimuat.
vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn() } }));

const { logger } = await import('../../src/config/logger.js');
const { errorHandler } = await import('../../src/middleware/errorHandler.js');
const { notFound } = await import('../../src/middleware/notFound.js');
const { validate } = await import('../../src/middleware/validate.js');
const { AppError } = await import('../../src/shared/errors/AppError.js');
const { asyncHandler } = await import('../../src/shared/utils/asyncHandler.js');
const { sendCreated, sendNoContent, sendOk, buildErrorBody } = await import('../../src/shared/utils/response.js');

const itemBody = z.object({
  name: z.string().min(2),
  amount: z.int().positive(),
});

let server: TestServer;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  app.post('/items', validate({ body: itemBody }), (req, res) => sendCreated(res, req.body));
  app.get(
    '/list',
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) }),
    (req, res) => sendOk(res, { limit: req.query.limit }),
  );
  app.get('/items/:id', validate({ params: z.object({ id: z.uuid() }) }), (req, res) =>
    sendOk(res, { id: req.params.id }),
  );
  app.post(
    '/both/:id',
    validate({ params: z.object({ id: z.uuid() }), body: itemBody }),
    (_req, res) => sendNoContent(res),
  );

  app.get('/app-error', () => {
    throw AppError.conflict('Email sudah terdaftar');
  });
  app.get(
    '/async-boom',
    asyncHandler(async () => {
      throw new Error('relation "users" does not exist');
    }),
  );
  app.get('/sync-boom', () => {
    throw new Error('rahasia internal: SUPABASE_SERVICE_ROLE_KEY=abc');
  });
  app.post('/boom-with-body', () => {
    throw new Error('gagal menyimpan');
  });
  app.get('/zod-thrown', () => {
    itemBody.parse({ name: 'x' });
  });
  app.get('/express5-async', async () => {
    throw AppError.forbidden();
  });

  app.use(notFound);
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  vi.mocked(logger.error).mockClear();
});

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; message: string; details?: { field?: string; issue: string }[] } };
  return body.error;
}

describe('validate', () => {
  it('meneruskan body valid dan membuang field tak dikenal (user_id di body tak berpengaruh)', async () => {
    const res = await postJson(`${server.url}/items`, { name: 'makan', amount: 25000, user_id: 'penyusup' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'makan', amount: 25000 });
  });

  it('400 VALIDATION_ERROR dengan details per field', async () => {
    const res = await postJson(`${server.url}/items`, { name: 'a', amount: 25000.5 });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.map((d) => d.field).sort()).toEqual(['amount', 'name']);
    expect(error.details?.every((d) => d.issue.length > 0)).toBe(true);
  });

  it('pesan validasi berbahasa Indonesia, bukan Inggris bawaan Zod', async () => {
    const res = await postJson(`${server.url}/items`, { name: 'makan', amount: 'banyak' });
    const { message } = await errorOf(res);
    expect(message).not.toMatch(/expected|invalid input|too small/i);
    expect(message).toMatch(/diharapkan|tidak valid|terlalu/i);
  });

  it('nominal nol, negatif, dan desimal ditolak', async () => {
    for (const amount of [0, -5000, 25.5, '25000']) {
      const res = await postJson(`${server.url}/items`, { name: 'makan', amount });
      expect(res.status, `amount=${JSON.stringify(amount)}`).toBe(400);
    }
  });

  it('query di-coerce dan diberi default (req.query read-only di Express 5 ditimpa dengan benar)', async () => {
    expect(await (await fetch(`${server.url}/list`)).json()).toEqual({ limit: 20 });
    expect(await (await fetch(`${server.url}/list?limit=50`)).json()).toEqual({ limit: 50 });
  });

  it('query tidak valid -> 400', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc']) {
      const res = await fetch(`${server.url}/list?${q}`);
      expect(res.status, q).toBe(400);
      expect((await errorOf(res)).details?.[0]?.field).toBe('limit');
    }
  });

  it('params bukan UUID -> 400', async () => {
    const res = await fetch(`${server.url}/items/bukan-uuid`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).details?.[0]?.field).toBe('id');
  });

  it('params valid diteruskan', async () => {
    const id = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
    expect(await (await fetch(`${server.url}/items/${id}`)).json()).toEqual({ id });
  });

  it('melaporkan masalah params dan body sekaligus', async () => {
    const res = await postJson(`${server.url}/both/bukan-uuid`, { name: 'a', amount: 0 });
    expect(res.status).toBe(400);
    const fields = (await errorOf(res)).details?.map((d) => d.field).sort();
    expect(fields).toEqual(['amount', 'id', 'name']);
  });
});

describe('errorHandler', () => {
  it('AppError -> status dan bentuk seragam', async () => {
    const res = await fetch(`${server.url}/app-error`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Email sudah terdaftar' } });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('async handler yang melempar AppError (Express 5 tanpa pembungkus)', async () => {
    const res = await fetch(`${server.url}/express5-async`);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
  });

  it('ZodError yang lolos dilempar langsung -> 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${server.url}/zod-thrown`);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  it('JSON rusak -> 400 VALIDATION_ERROR, bukan 500', async () => {
    const res = await postJson(`${server.url}/items`, '{ ini bukan json');
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Body bukan JSON yang valid');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(['/async-boom', '/sync-boom'])('error tak terduga di %s -> 500 generik tanpa bocor', async (path) => {
    const res = await fetch(`${server.url}${path}`);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server' } });
    expect(text).not.toMatch(/relation|SUPABASE|rahasia|stack/i);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('log hanya memuat error, method, dan path; body dan nominal tidak ikut', async () => {
    await postJson(`${server.url}/boom-with-body`, { amount: 987654, description: 'gaji rahasia' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [context] = vi.mocked(logger.error).mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(context).sort()).toEqual(['err', 'method', 'path']);
    expect(context.method).toBe('POST');
    expect(context.path).toBe('/boom-with-body');
    expect(JSON.stringify(context)).not.toMatch(/987654|gaji rahasia/);
  });
});

describe('notFound', () => {
  it('route tak dikenal -> 404 berbentuk error seragam, bukan HTML', async () => {
    const res = await fetch(`${server.url}/tidak-ada`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const error = await errorOf(res);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('/tidak-ada');
  });
});

describe('AppError dan buildErrorBody', () => {
  it.each([
    ['validation', AppError.validation('x'), 'VALIDATION_ERROR', 400],
    ['unauthorized', AppError.unauthorized(), 'UNAUTHORIZED', 401],
    ['forbidden', AppError.forbidden(), 'FORBIDDEN', 403],
    ['notFound', AppError.notFound(), 'NOT_FOUND', 404],
    ['conflict', AppError.conflict('x'), 'CONFLICT', 409],
    ['rateLimited', AppError.rateLimited(30), 'RATE_LIMITED', 429],
    ['unavailable', AppError.unavailable('x'), 'SERVICE_UNAVAILABLE', 503],
  ])('%s -> %s (%d)', (_name, error, code, status) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error).toBeInstanceOf(Error);
  });

  it('rateLimited membawa retry_after_seconds', () => {
    expect(AppError.rateLimited(42).details).toEqual([{ issue: 'rate_limited', retry_after_seconds: 42 }]);
  });

  it('buildErrorBody menyertakan details hanya bila ada', () => {
    expect(buildErrorBody(AppError.notFound('Tidak ada'))).toEqual({
      error: { code: 'NOT_FOUND', message: 'Tidak ada' },
    });
    expect(buildErrorBody(AppError.validation('Salah', [{ field: 'amount', issue: 'too_small' }]))).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Salah', details: [{ field: 'amount', issue: 'too_small' }] },
    });
    expect(buildErrorBody(AppError.validation('Salah', []))).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Salah' },
    });
  });
});
