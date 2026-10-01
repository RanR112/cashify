// Satu-satunya tempat yang memanggil Supabase Auth. Auth adalah bagian yang paling mahal
// dipindahkan dari Supabase, jadi tidak ada berkas lain yang boleh mengimpor
// `@supabase/supabase-js` (BACKEND-BRIEF.md, ARCHITECTURE.md Bagian 20).
//
// PRASYARAT DI LUAR KODE (tidak diotomatisasi, semuanya gratis):
//  - Login Google: buat OAuth client di Google Cloud Console, lalu masukkan Client ID dan
//    Secret ke dashboard Supabase -> Authentication -> Providers -> Google. Backend tidak
//    pernah memegang client secret Google; Supabase yang memverifikasi `id_token` ke Google.
//    Untuk login lewat ID token, Client ID klien (Android/iOS/Web) harus terdaftar di kolom
//    "Authorized Client IDs" provider itu.
//  - Konfirmasi email dimatikan (Authentication -> Providers -> Email), supaya register
//    langsung menghasilkan sesi (claude/API.md Bagian 11).
//  - Penautan identitas (email yang sama lewat password dan Google) mengikuti pengaturan
//    "manual linking" di dashboard. Kode ini tidak mengasumsikan salah satunya: apa pun
//    penolakan Supabase diterjemahkan oleh `mapAuthError` menjadi pesan yang jelas.

import { createClient, isAuthApiError, isAuthRetryableFetchError, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { AppError } from '../shared/errors/AppError.js';

// ---- bentuk milik kita; tipe Supabase tidak boleh bocor keluar berkas ini ----

export interface AuthIdentity {
  id: string;
  email: string;
  /** Dari user_metadata (diisi Google atau saat register); bisa kosong. */
  fullName: string | undefined;
  avatarUrl: string | undefined;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
}

export interface AuthResult {
  identity: AuthIdentity;
  session: AuthSession;
}

export interface SignUpResult {
  identity: AuthIdentity;
  /** Null bila konfirmasi email menyala di Supabase. */
  session: AuthSession | null;
}

export interface AuthProvider {
  signUp(input: { email: string; password: string; fullName: string }): Promise<SignUpResult>;
  signInWithPassword(input: { email: string; password: string }): Promise<AuthResult>;
  signInWithGoogleIdToken(idToken: string): Promise<AuthResult>;
  refreshSession(refreshToken: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  resetPassword(recoveryToken: string, newPassword: string): Promise<void>;
  /** Kompensasi bila register gagal sesudah akun Supabase terbentuk. */
  deleteUser(userId: string): Promise<void>;
}

// ---- pemetaan error ----

export type AuthOperation = 'signUp' | 'login' | 'google' | 'refresh' | 'logout' | 'forgot' | 'reset' | 'admin';

const LINKING_MESSAGE =
  'Email ini sudah terdaftar dengan metode masuk lain. Masuk dengan metode yang dipakai saat mendaftar ' +
  '(email dan password, atau Google).';

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Menerjemahkan error Supabase Auth menjadi AppError yang aman ditampilkan.
 * Mengembalikan null untuk error yang tidak dikenal; pemanggil melemparnya ulang sehingga
 * jadi 500 generik dan tercatat di server (pesan mentah Supabase tidak sampai ke klien).
 */
export function mapAuthError(error: unknown, operation: AuthOperation): AppError | null {
  if (isAuthRetryableFetchError(error)) {
    return AppError.unavailable('Layanan autentikasi sedang tidak dapat dihubungi, coba lagi nanti');
  }
  if (!isAuthApiError(error)) return null;

  const code = errorCodeOf(error);
  switch (code) {
    case 'user_already_exists':
    case 'email_exists':
      return AppError.conflict('Email sudah terdaftar', [{ field: 'email', issue: 'already_registered' }]);

    case 'identity_already_exists':
    case 'email_conflict_identity_not_deletable':
    case 'manual_linking_disabled':
    case 'provider_email_needs_verification':
      return AppError.conflict(LINKING_MESSAGE, [{ field: 'email', issue: 'account_exists_other_provider' }]);

    case 'invalid_credentials':
      return AppError.unauthorized(
        'Email atau password salah. Jika Anda mendaftar dengan Google, masuk lewat Google.',
      );
    case 'email_not_confirmed':
      return AppError.unauthorized('Email belum dikonfirmasi');
    case 'user_banned':
      return AppError.unauthorized('Akun ini dinonaktifkan');
    case 'conflict':
      return AppError.conflict('Permintaan bertabrakan dengan permintaan lain, coba lagi');

    case 'weak_password':
    case 'same_password':
      return AppError.validation(
        code === 'same_password' ? 'Password baru harus berbeda dari yang lama' : 'Password terlalu lemah',
        [{ field: 'password', issue: code }],
      );

    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return AppError.rateLimited(60);

    case 'provider_disabled':
    case 'oauth_provider_not_supported':
      // Konfigurasi dashboard, bukan kesalahan pengguna.
      return AppError.unavailable('Login Google belum diaktifkan di server');

    case 'signup_disabled':
      return AppError.unavailable('Pendaftaran akun baru dinonaktifkan di server');

    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt':
    case 'otp_expired':
      return AppError.unauthorized(
        operation === 'reset' ? 'Token pemulihan tidak valid atau kedaluwarsa' : 'Sesi tidak valid atau kedaluwarsa',
      );
  }

  // Penolakan token Google tidak punya kode tunggal (400 `validation_failed` atau pesan
  // "Invalid ... token"); untuk operasi ini semuanya berarti token tidak diterima.
  if (operation === 'google' && (error.status === 400 || error.status === 401 || error.status === 422)) {
    return AppError.unauthorized('Token Google tidak valid atau kedaluwarsa');
  }
  if (operation === 'refresh' && (error.status === 400 || error.status === 401)) {
    return AppError.unauthorized('Refresh token tidak valid');
  }
  if (operation === 'reset' && (error.status === 400 || error.status === 401 || error.status === 403)) {
    return AppError.unauthorized('Token pemulihan tidak valid atau kedaluwarsa');
  }
  if (error.status === 429) return AppError.rateLimited(60);
  return null;
}

/** Menjalankan panggilan Supabase; error yang dikenal menjadi AppError, sisanya dilempar apa adanya. */
async function guard<T>(operation: AuthOperation, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mapAuthError(error, operation) ?? error;
  }
}

// ---- implementasi Supabase ----

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

const STATELESS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

function pickString(meta: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function toIdentity(user: User): AuthIdentity {
  if (!user.email) {
    // Semua jalur masuk yang didukung (email, Google) menyertakan email.
    throw new Error('Pengguna Supabase tanpa email');
  }
  const meta = user.user_metadata as Record<string, unknown> | undefined;
  return {
    id: user.id,
    email: user.email,
    fullName: pickString(meta, 'full_name', 'name'),
    avatarUrl: pickString(meta, 'avatar_url', 'picture'),
  };
}

function toSession(session: Session): AuthSession {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'bearer',
    expires_in: session.expires_in,
    // supabase-js mengisi expires_at; hitung sendiri bila server lama tidak mengirimnya.
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
  };
}

/**
 * Klien dibuat lazy: env.ts memanggil process.exit bila variabel hilang, jadi berkas ini
 * harus bisa diimpor di test tanpa .env.
 */
export function createSupabaseAuthProvider(config: SupabaseAuthConfig): AuthProvider {
  let anon: SupabaseClient | undefined;
  let admin: SupabaseClient | undefined;
  const anonClient = () => (anon ??= createClient(config.url, config.anonKey, STATELESS));
  const adminClient = () => (admin ??= createClient(config.url, config.serviceRoleKey, STATELESS));

  // Respons Supabase berbentuk union {data, error: null} | {data kosong, error}; di sini
  // yang gagal dilempar, sehingga tipe sisanya adalah cabang sukses.
  type Success<R> = R extends { data: infer D; error: null } ? D : never;
  function requireData<R extends { data: unknown; error: unknown }>(result: R): Success<R> {
    if (result.error) throw result.error;
    return result.data as Success<R>;
  }

  return {
    signUp: ({ email, password, fullName }) =>
      guard('signUp', async () => {
        const { user, session } = requireData(
          await anonClient().auth.signUp({ email, password, options: { data: { full_name: fullName } } }),
        );
        // Email yang sudah terdaftar dan terkonfirmasi: Supabase membalas sukses dengan
        // `identities` kosong (anti-enumerasi) alih-alih error.
        if (!user || (user.identities && user.identities.length === 0)) {
          throw AppError.conflict('Email sudah terdaftar', [{ field: 'email', issue: 'already_registered' }]);
        }
        return { identity: toIdentity(user), session: session ? toSession(session) : null };
      }),

    signInWithPassword: ({ email, password }) =>
      guard('login', async () => {
        const { user, session } = requireData(await anonClient().auth.signInWithPassword({ email, password }));
        return { identity: toIdentity(user), session: toSession(session) };
      }),

    signInWithGoogleIdToken: (idToken) =>
      guard('google', async () => {
        const { user, session } = requireData(
          await anonClient().auth.signInWithIdToken({ provider: 'google', token: idToken }),
        );
        return { identity: toIdentity(user), session: toSession(session) };
      }),

    refreshSession: (refreshToken) =>
      guard('refresh', async () => {
        const { session } = requireData(await anonClient().auth.refreshSession({ refresh_token: refreshToken }));
        if (!session) throw AppError.unauthorized('Refresh token tidak valid');
        return toSession(session);
      }),

    signOut: (accessToken) =>
      guard('logout', async () => {
        const { error } = await adminClient().auth.admin.signOut(accessToken, 'global');
        if (error) throw error;
      }),

    sendPasswordReset: (email) =>
      guard('forgot', async () => {
        const { error } = await anonClient().auth.resetPasswordForEmail(email);
        if (error) throw error;
      }),

    resetPassword: (recoveryToken, newPassword) =>
      guard('reset', async () => {
        // Token pemulihan divalidasi lewat getUser, lalu password diganti lewat API admin.
        // Cara ini stateless: tidak ada sesi yang perlu dipasang di klien server.
        const { user } = requireData(await adminClient().auth.getUser(recoveryToken));
        if (!user) throw AppError.unauthorized('Token pemulihan tidak valid atau kedaluwarsa');
        const { error } = await adminClient().auth.admin.updateUserById(user.id, { password: newPassword });
        if (error) throw error;
      }),

    deleteUser: (userId) =>
      guard('admin', async () => {
        const { error } = await adminClient().auth.admin.deleteUser(userId);
        if (error) throw error;
      }),
  };
}

/**
 * Provider bawaan yang dikonfigurasi dari env. env dimuat saat panggilan pertama (bukan
 * saat impor) karena env.ts memanggil process.exit bila variabel hilang.
 */
export function createEnvAuthProvider(): AuthProvider {
  let inner: AuthProvider | undefined;
  const get = async (): Promise<AuthProvider> => {
    if (!inner) {
      const { env } = await import('../config/env.js');
      inner = createSupabaseAuthProvider({
        url: env.SUPABASE_URL,
        anonKey: env.SUPABASE_ANON_KEY,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    return inner;
  };

  return {
    signUp: async (input) => (await get()).signUp(input),
    signInWithPassword: async (input) => (await get()).signInWithPassword(input),
    signInWithGoogleIdToken: async (idToken) => (await get()).signInWithGoogleIdToken(idToken),
    refreshSession: async (refreshToken) => (await get()).refreshSession(refreshToken),
    signOut: async (accessToken) => (await get()).signOut(accessToken),
    sendPasswordReset: async (email) => (await get()).sendPasswordReset(email),
    resetPassword: async (token, password) => (await get()).resetPassword(token, password),
    deleteUser: async (userId) => (await get()).deleteUser(userId),
  };
}
