import express from 'express';
import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthenticate } from '../../src/middleware/authenticate.js';
import { createTokenVerifier } from '../../src/shared/utils/token.js';
import { postJson, readJson, startServer, type TestServer } from '../helpers/http.js';

// errorHandler mengimpor logger -> env (process.exit bila .env tidak dimuat).
vi.mock('../../src/config/logger.js', () => ({ logger: { error: vi.fn() } }));
const { errorHandler } = await import('../../src/middleware/errorHandler.js');

const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const SECRET = 'rahasia-hs256-untuk-test-saja-minimal-32-karakter';
const USER_ID = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';

let server: TestServer;
let es256Private: CryptoKey;
let otherPrivate: CryptoKey;

const secretKey = new TextEncoder().encode(SECRET);

interface TokenOptions {
  sub?: string | null;
  iss?: string;
  aud?: string;
  exp?: number | string;
  email?: string;
}

function claims(options: TokenOptions) {
  let jwt = new SignJWT(options.email ? { email: options.email } : {})
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? 'authenticated')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(options.exp ?? '1h');
  if (options.sub !== null) jwt = jwt.setSubject(options.sub ?? USER_ID);
  return jwt;
}

const hs256 = (options: TokenOptions = {}) =>
  claims(options).setProtectedHeader({ alg: 'HS256' }).sign(secretKey);
const es256 = (options: TokenOptions = {}, key: CryptoKey = es256Private) =>
  claims(options).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(key);

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  es256Private = pair.privateKey;
  otherPrivate = (await generateKeyPair('ES256')).privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

  const verify = createTokenVerifier({
    supabaseUrl: `${SUPABASE_URL}/`, // garis miring di akhir harus dinormalisasi
    jwtSecret: SECRET,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  });

  const app = express();
  app.use(express.json());
  app.post('/whoami', createAuthenticate(verify), (req, res) => {
    res.json({ id: req.user?.id, email: req.user?.email, bodyUserId: req.body?.user_id });
  });
  app.use(errorHandler);
  server = await startServer(app);
});

afterAll(async () => {
  await server.close();
});

function whoami(token?: string, scheme = 'Bearer', body: unknown = {}) {
  return postJson(`${server.url}/whoami`, body, token ? { authorization: `${scheme} ${token}` } : {});
}

describe('token valid', () => {
  it('HS256 (secret lama): user_id dari klaim sub', async () => {
    const res = await whoami(await hs256({ email: 'dey@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: USER_ID, email: 'dey@example.com' });
  });

  it('ES256 (signing key asimetrik) lewat JWKS', async () => {
    const res = await whoami(await es256());
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe(USER_ID);
  });

  it('skema Bearer tidak peka huruf besar-kecil', async () => {
    expect((await whoami(await hs256(), 'bearer')).status).toBe(200);
  });

  it('email opsional', async () => {
    const body = await readJson(await whoami(await hs256()));
    expect(body.email).toBeUndefined();
  });
});

describe('aturan 8: user_id hanya dari JWT', () => {
  it('user_id di body diabaikan untuk identitas', async () => {
    const res = await whoami(await hs256(), 'Bearer', { user_id: 'penyusup-0000' });
    const body = await readJson(res);
    expect(body.id).toBe(USER_ID);
    expect(body.id).not.toBe(body.bodyUserId);
  });
});

describe('401 UNAUTHORIZED', () => {
  async function expectUnauthorized(res: Response, messagePattern?: RegExp) {
    expect(res.status).toBe(401);
    const { error } = await readJson(res);
    expect(error.code).toBe('UNAUTHORIZED');
    if (messagePattern) expect(error.message).toMatch(messagePattern);
    return error;
  }

  it('tanpa header Authorization', async () => {
    await expectUnauthorized(await whoami(), /tidak ada/);
  });

  it('skema selain Bearer', async () => {
    await expectUnauthorized(await whoami('dXNlcjpwYXNz', 'Basic'));
  });

  it('Bearer tanpa token', async () => {
    const res = await postJson(`${server.url}/whoami`, {}, { authorization: 'Bearer ' });
    await expectUnauthorized(res);
  });

  it('token ngawur', async () => {
    await expectUnauthorized(await whoami('token-ngawur'));
  });

  it('token kedaluwarsa', async () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    await expectUnauthorized(await whoami(await hs256({ exp: expired })));
    await expectUnauthorized(await whoami(await es256({ exp: expired })));
  });

  it('audience salah', async () => {
    await expectUnauthorized(await whoami(await hs256({ aud: 'anon' })));
  });

  it('issuer salah (proyek Supabase lain)', async () => {
    await expectUnauthorized(await whoami(await hs256({ iss: 'https://lain.supabase.co/auth/v1' })));
    await expectUnauthorized(await whoami(await es256({ iss: 'https://lain.supabase.co/auth/v1' })));
  });

  it('tanpa klaim sub', async () => {
    await expectUnauthorized(await whoami(await hs256({ sub: null })));
  });

  it('sub kosong', async () => {
    await expectUnauthorized(await whoami(await hs256({ sub: '' })));
  });

  it('HS256 ditandatangani dengan secret lain', async () => {
    const forged = await claims({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('secret-palsu-0123456789-0123456789'));
    await expectUnauthorized(await whoami(forged));
  });

  it('ES256 ditandatangani dengan kunci yang tidak ada di JWKS', async () => {
    await expectUnauthorized(await whoami(await es256({}, otherPrivate)));
  });

  it('token tanpa tanda tangan (alg none)', async () => {
    const unsigned = new UnsecuredJWT({})
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject(USER_ID)
      .setExpirationTime('1h')
      .encode();
    await expectUnauthorized(await whoami(unsigned));
  });

  it('token ES256 yang header alg-nya diganti HS256 (algorithm confusion)', async () => {
    const [, payload] = (await es256()).split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
    await expectUnauthorized(await whoami(`${header}.${payload}.AAAA`));
  });

  it('header Authorization absurd panjang ditolak', async () => {
    await expectUnauthorized(await whoami('a'.repeat(9000)));
  });

  it('pesan error tidak membocorkan alasan penolakan', async () => {
    const reasons = [
      await whoami(await hs256({ exp: Math.floor(Date.now() / 1000) - 60 })),
      await whoami(await hs256({ aud: 'anon' })),
      await whoami('token-ngawur'),
    ];
    const messages = await Promise.all(reasons.map(async (r) => (await readJson(r)).error.message));
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toMatch(/exp|aud|signature|tanda tangan|issuer/i);
  });
});
