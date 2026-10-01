// Alat test integrasi: klien Prisma ke Postgres test, pembersih data, dan FakeAuthProvider
// yang meniru Supabase Auth tanpa jaringan (Supabase dan Google tidak pernah dipanggil).

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_CATEGORIES } from '../../prisma/seed-data.js';
import type { AuthIdentity, AuthProvider, AuthSession, SignUpResult } from '../../src/lib/auth.js';
import { AppError } from '../../src/shared/errors/AppError.js';

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:54329/postgres';

/** Test menghapus isi tabel; tolak apa pun selain database lokal. */
export function assertSafeTestDbUrl(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`TEST_DATABASE_URL harus mengarah ke database lokal, bukan "${host}"`);
  }
}

export function createTestPrisma(url: string): PrismaClient {
  assertSafeTestDbUrl(url);
  return new PrismaClient({ datasourceUrl: url });
}

/** Menghapus semua data pengguna. Menghapus auth.users ikut menghapus users, accounts, dan kategori pengguna (CASCADE). */
export async function resetUserData(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`DELETE FROM auth.users`;
  await prisma.user.deleteMany();
}

/** Memastikan kategori sistem ada (sebuah test sengaja menghapusnya). */
export async function ensureSystemCategories(prisma: PrismaClient): Promise<void> {
  if ((await prisma.category.count({ where: { userId: null } })) > 0) return;
  await prisma.category.createMany({ data: SYSTEM_CATEGORIES.map((category) => ({ ...category, userId: null })) });
}

export const SYSTEM_CATEGORY_COUNT = SYSTEM_CATEGORIES.length;

// ---- FakeAuthProvider ----

interface FakeUser {
  id: string;
  email: string;
  password: string | undefined;
  fullName: string | undefined;
  avatarUrl: string | undefined;
  providers: Set<'password' | 'google'>;
}

export interface FakeGoogleToken {
  email: string;
  name?: string;
  picture?: string;
}

export const LINKING_ERROR = AppError.conflict(
  'Email ini sudah terdaftar dengan metode masuk lain. Masuk dengan metode yang dipakai saat mendaftar ' +
    '(email dan password, atau Google).',
  [{ field: 'email', issue: 'account_exists_other_provider' }],
);

/**
 * Meniru Supabase Auth. Baris `auth.users` benar-benar ditulis ke database test supaya FK
 * users.id -> auth.users(id) berlaku seperti di Supabase. Pengecualian yang dilempar sudah
 * berbentuk AppError, persis hasil `mapAuthError` pada provider asli (diuji di unit test).
 */
export class FakeAuthProvider implements AuthProvider {
  readonly users = new Map<string, FakeUser>();
  readonly googleTokens = new Map<string, FakeGoogleToken>();
  readonly recoveryTokens = new Map<string, string>();
  readonly deletedUserIds: string[] = [];
  readonly revokedAccessTokens: string[] = [];
  readonly passwordResetEmails: string[] = [];
  /** 'link': Google menautkan ke akun password dengan email sama. 'reject': ditolak (manual linking). */
  linkingPolicy: 'link' | 'reject' = 'link';
  /** Meniru konfirmasi email menyala: signUp tidak mengembalikan sesi. */
  requireEmailConfirmation = false;
  failDeleteUser = false;

  private readonly sessions = new Map<string, string>(); // access_token -> user id
  private readonly refreshTokens = new Map<string, string>(); // refresh_token -> user id
  private counter = 0;

  constructor(private readonly prisma: PrismaClient) {}

  /** Untuk createAuthenticate: access token milik sesi yang diterbitkan fake ini. */
  verifyAccessToken = async (token: string): Promise<{ id: string; email?: string }> => {
    const id = this.sessions.get(token);
    if (!id) throw AppError.unauthorized('Token tidak valid atau kedaluwarsa');
    // Supabase menaruh email di klaim JWT; /me membacanya dari sana.
    const email = [...this.users.values()].find((user) => user.id === id)?.email;
    return { id, ...(email && { email }) };
  };

  addGoogleToken(token: string, claims: FakeGoogleToken): void {
    this.googleTokens.set(token, claims);
  }

  private issueSession(userId: string): AuthSession {
    this.counter += 1;
    const access_token = `access-${this.counter}`;
    const refresh_token = `refresh-${this.counter}`;
    this.sessions.set(access_token, userId);
    this.refreshTokens.set(refresh_token, userId);
    return { access_token, refresh_token, token_type: 'bearer', expires_in: 3600, expires_at: 1790000000 };
  }

  private identityOf(user: FakeUser): AuthIdentity {
    return { id: user.id, email: user.email, fullName: user.fullName, avatarUrl: user.avatarUrl };
  }

  private async insertUser(user: FakeUser): Promise<void> {
    this.users.set(user.email, user);
    await this.prisma.$executeRaw`INSERT INTO auth.users (id, email) VALUES (${user.id}::uuid, ${user.email})`;
  }

  async signUp(input: { email: string; password: string; fullName: string }): Promise<SignUpResult> {
    if (this.users.has(input.email)) {
      throw AppError.conflict('Email sudah terdaftar', [{ field: 'email', issue: 'already_registered' }]);
    }
    const user: FakeUser = {
      id: randomUUID(),
      email: input.email,
      password: input.password,
      fullName: input.fullName,
      avatarUrl: undefined,
      providers: new Set(['password']),
    };
    await this.insertUser(user);
    return { identity: this.identityOf(user), session: this.requireEmailConfirmation ? null : this.issueSession(user.id) };
  }

  async signInWithPassword(input: { email: string; password: string }) {
    const user = this.users.get(input.email);
    if (!user || user.password === undefined || user.password !== input.password) {
      throw AppError.unauthorized('Email atau password salah. Jika Anda mendaftar dengan Google, masuk lewat Google.');
    }
    return { identity: this.identityOf(user), session: this.issueSession(user.id) };
  }

  async signInWithGoogleIdToken(idToken: string) {
    const claims = this.googleTokens.get(idToken);
    if (!claims) throw AppError.unauthorized('Token Google tidak valid atau kedaluwarsa');

    let user = this.users.get(claims.email);
    if (user && !user.providers.has('google')) {
      if (this.linkingPolicy === 'reject') throw LINKING_ERROR;
      user.providers.add('google');
    }
    if (!user) {
      user = {
        id: randomUUID(),
        email: claims.email,
        password: undefined,
        fullName: claims.name,
        avatarUrl: claims.picture,
        providers: new Set(['google']),
      };
      await this.insertUser(user);
    }
    return { identity: this.identityOf(user), session: this.issueSession(user.id) };
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const userId = this.refreshTokens.get(refreshToken);
    if (!userId) throw AppError.unauthorized('Refresh token tidak valid');
    this.refreshTokens.delete(refreshToken); // dirotasi: sekali pakai
    return this.issueSession(userId);
  }

  async signOut(accessToken: string): Promise<void> {
    this.revokedAccessTokens.push(accessToken);
    this.sessions.delete(accessToken);
  }

  async sendPasswordReset(email: string): Promise<void> {
    this.passwordResetEmails.push(email); // email tak dikenal pun diterima diam-diam, seperti Supabase
  }

  async resetPassword(recoveryToken: string, newPassword: string): Promise<void> {
    const email = this.recoveryTokens.get(recoveryToken);
    const user = email ? this.users.get(email) : undefined;
    if (!user) throw AppError.unauthorized('Token pemulihan tidak valid atau kedaluwarsa');
    user.password = newPassword;
  }

  async deleteUser(userId: string): Promise<void> {
    if (this.failDeleteUser) throw new Error('Supabase tidak dapat dihubungi');
    this.deletedUserIds.push(userId);
    for (const [email, user] of this.users) if (user.id === userId) this.users.delete(email);
    await this.prisma.$executeRaw`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
}
