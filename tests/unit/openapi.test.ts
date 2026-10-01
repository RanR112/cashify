import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/config/openapi.js';
import { oneYearBefore, todayInJakarta } from '../../src/shared/utils/timezone.js';
import { loginBodySchema, registerBodySchema } from '../../src/modules/auth/auth.schema.js';
import {
  createTransactionBodySchema,
  listTransactionsQuerySchema,
  updateTransactionBodySchema,
} from '../../src/modules/transactions/transactions.schema.js';
import { linkVerifyBodySchema, linkRequestBodySchema } from '../../src/modules/whatsapp/whatsapp.schema.js';

const ROOT = resolve(import.meta.dirname, '../..');

// Cakupan P04 (PROMPTS.md). Menambah endpoint di luar daftar ini harus lewat keputusan eksplisit.
const EXPECTED_OPERATIONS = [
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/google',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'GET /me',
  'PATCH /me',
  'GET /dashboard',
  'GET /transactions',
  'POST /transactions',
  'GET /transactions/{id}',
  'PATCH /transactions/{id}',
  'DELETE /transactions/{id}',
  'POST /transactions/{id}/restore',
  'GET /categories',
  'GET /accounts',
  'GET /whatsapp/status',
  'POST /whatsapp/link/request',
  'POST /whatsapp/link/verify',
  'POST /whatsapp/link/resend',
  'DELETE /whatsapp/link',
  'PATCH /whatsapp/preferences',
  'POST /webhooks/openwa/{path}',
  'GET /health',
].sort();

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const document = buildOpenApiDocument();

function operations(): string[] {
  return Object.entries(document.paths ?? {})
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => HTTP_METHODS.includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

/** Telusuri semua skema (inline dan komponen) dan kumpulkan [jalur, node]. */
function walk(node: unknown, path: string, visit: (path: string, node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, visit));
  } else if (node && typeof node === 'object') {
    visit(path, node as Record<string, unknown>);
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`, visit);
  }
}

describe('dokumen OpenAPI', () => {
  it('berisi tepat 25 operasi dari daftar cakupan, tidak lebih tidak kurang', () => {
    expect(operations()).toEqual(EXPECTED_OPERATIONS);
  });

  it('claude/openapi.json tidak basi terhadap skema Zod (jalankan npm run openapi)', () => {
    const exported = JSON.parse(readFileSync(resolve(ROOT, 'claude/openapi.json'), 'utf8'));
    expect(exported).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it('semua kolom uang bertipe integer (aturan 1)', () => {
    const moneyKeys = ['amount', 'initial_balance', 'balance', 'income', 'expense', 'net'];
    const found: string[] = [];
    walk(document, '$', (path, node) => {
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (!properties) return;
      for (const key of moneyKeys) {
        if (properties[key]) {
          found.push(`${path}.${key}`);
          expect(properties[key].type, `${path}.${key}`).toBe('integer');
        }
      }
    });
    expect(found.length).toBeGreaterThan(5);
  });

  it('tidak ada user_id di request: parameter, query, maupun body (aturan 8)', () => {
    const offenders: string[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const operation = op as { parameters?: { name: string }[]; requestBody?: unknown };
        if (operation.parameters?.some((p) => p.name === 'user_id')) offenders.push(`${method} ${path}`);
        walk(operation.requestBody, '$', (_p, node) => {
          const properties = node.properties as Record<string, unknown> | undefined;
          if (properties && 'user_id' in properties) offenders.push(`${method} ${path} body`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('endpoint ber-JWT dan webhook memiliki respons 401', () => {
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const operation = op as { security?: unknown[]; responses: Record<string, unknown> };
        if ((operation.security?.length ?? 0) > 0) {
          expect(operation.responses['401'], `${method} ${path}`).toBeDefined();
        }
      }
    }
  });
});

describe('koleksi rest/ konsisten dengan kontrak', () => {
  const restDir = resolve(ROOT, 'rest');
  const requestLine = /^(GET|POST|PUT|PATCH|DELETE)\s+(?:\{\{baseUrl\}\}|\{\{@baseUrl\}\})(\S*)/;

  function restOperations(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const file of readdirSync(restDir).filter((f) => f.endsWith('.http'))) {
      for (const line of readFileSync(resolve(restDir, file), 'utf8').split(/\r?\n/)) {
        const match = requestLine.exec(line.trim());
        if (!match) continue;
        const method = match[1] as string;
        const path = (match[2] as string).split('?')[0]!; // buang query
        const key = `${method} ${path}`;
        result.set(key, [...(result.get(key) ?? []), file]);
      }
    }
    return result;
  }

  /** Cocokkan "GET /transactions/bukan-uuid" dengan templat "GET /transactions/{id}", per segmen. */
  function matches(requestKey: string, templateKey: string): boolean {
    const [reqMethod, reqPath = ''] = requestKey.split(' ');
    const [tplMethod, tplPath = ''] = templateKey.split(' ');
    if (reqMethod !== tplMethod) return false;
    const req = reqPath.split('/');
    const tpl = tplPath.split('/');
    return req.length === tpl.length && tpl.every((seg, i) => seg.startsWith('{') || seg === req[i]);
  }

  it('setiap operasi punya contoh request di rest/', () => {
    const requests = [...restOperations().keys()];
    const missing = EXPECTED_OPERATIONS.filter((op) => !requests.some((r) => matches(r, op)));
    expect(missing).toEqual([]);
  });

  it('setiap request di rest/ menunjuk operasi yang ada di kontrak', () => {
    const unknown = [...restOperations().keys()].filter(
      (r) => !EXPECTED_OPERATIONS.some((op) => matches(r, op)),
    );
    expect(unknown).toEqual([]);
  });
});

describe('validasi skema request', () => {
  const validCreate = {
    type: 'expense',
    amount: 25000,
    category_id: '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21',
    account_id: '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d',
    date: todayInJakarta(),
    description: 'makan siang',
  };

  it('menerima transaksi yang valid', () => {
    expect(createTransactionBodySchema.safeParse(validCreate).success).toBe(true);
  });

  it.each([
    ['nominal nol', { amount: 0 }],
    ['nominal negatif', { amount: -5000 }],
    ['nominal desimal', { amount: 25000.5 }],
    ['nominal string', { amount: '25000' }],
    ['nominal di atas Rp1 miliar', { amount: 1_000_000_001 }],
    ['tipe tak dikenal', { type: 'transfer' }],
    ['tanggal masa depan', { date: '2999-01-01' }],
    ['tanggal lebih dari setahun lalu', { date: '2000-01-01' }],
    ['deskripsi lebih dari 255 karakter', { description: 'x'.repeat(256) }],
    ['category_id bukan UUID', { category_id: 'makanan' }],
  ])('menolak %s', (_label, override) => {
    expect(createTransactionBodySchema.safeParse({ ...validCreate, ...override }).success).toBe(false);
  });

  it('PATCH transaksi wajib updated_at dan minimal satu field lain', () => {
    const updatedAt = '2026-09-28T05:12:35Z';
    expect(updateTransactionBodySchema.safeParse({ amount: 30000 }).success).toBe(false);
    expect(updateTransactionBodySchema.safeParse({ updated_at: updatedAt }).success).toBe(false);
    expect(updateTransactionBodySchema.safeParse({ updated_at: updatedAt, amount: 30000 }).success).toBe(true);
    expect(updateTransactionBodySchema.safeParse({ updated_at: updatedAt, description: null }).success).toBe(true);
  });

  it('daftar transaksi: limit di-coerce, default 20, maksimal 100, from <= to', () => {
    expect(listTransactionsQuerySchema.parse({}).limit).toBe(20);
    expect(listTransactionsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listTransactionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listTransactionsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listTransactionsQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(false);
  });

  it('register: password minimal 8, saldo awal bulat ≥ 0 dan default 0', () => {
    const base = { email: 'dey@example.com', password: 'rahasia-banget-123', full_name: 'Dey' };
    expect(registerBodySchema.parse(base).initial_balance).toBe(0);
    expect(registerBodySchema.safeParse({ ...base, password: 'pendek' }).success).toBe(false);
    expect(registerBodySchema.safeParse({ ...base, initial_balance: -1 }).success).toBe(false);
    expect(registerBodySchema.safeParse({ ...base, initial_balance: 100.5 }).success).toBe(false);
    expect(registerBodySchema.safeParse({ ...base, email: 'bukan-email' }).success).toBe(false);
    expect(loginBodySchema.safeParse({ email: 'dey@example.com', password: '' }).success).toBe(false);
  });

  it('WhatsApp: nomor harus E.164 berawalan +62, kode OTP 6 digit', () => {
    expect(linkRequestBodySchema.safeParse({ phone: '+628123456789' }).success).toBe(true);
    expect(linkRequestBodySchema.safeParse({ phone: '08123456789' }).success).toBe(false);
    expect(linkRequestBodySchema.safeParse({ phone: '+14155550123' }).success).toBe(false);
    expect(linkVerifyBodySchema.safeParse({ code: '483920' }).success).toBe(true);
    expect(linkVerifyBodySchema.safeParse({ code: '48392' }).success).toBe(false);
    expect(linkVerifyBodySchema.safeParse({ code: 'abcdef' }).success).toBe(false);
  });
});

describe('timezone', () => {
  it('todayInJakarta memakai tanggal WIB, bukan UTC', () => {
    // 2026-09-28 20:00 UTC = 2026-09-29 03:00 WIB
    expect(todayInJakarta(new Date('2026-09-28T20:00:00Z'))).toBe('2026-09-29');
  });

  it('oneYearBefore menangani 29 Februari', () => {
    expect(oneYearBefore('2028-02-29')).toBe('2027-02-28');
    expect(oneYearBefore('2026-09-28')).toBe('2025-09-28');
  });
});
