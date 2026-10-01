import type { z } from 'zod';
import type { AuthIdentity, AuthProvider, AuthSession } from '../../lib/auth.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../shared/errors/AppError.js';
import { toUserProfile } from '../../shared/mappers/userProfile.js';
import type {
  forgotPasswordBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
} from './auth.schema.js';
import { UserAlreadyProvisionedError } from './auth.repository.js';
import type { AuthRepository, AuthResultBody, UserRecord } from './auth.types.js';

export const FORGOT_PASSWORD_MESSAGE = 'Jika email terdaftar, tautan reset telah dikirim.';

const FULL_NAME_MIN = 2;
const FULL_NAME_MAX = 100;
const FALLBACK_NAME = 'Pengguna';

export interface AuthServiceDeps {
  provider: AuthProvider;
  repository: AuthRepository;
}

type RegisterInput = z.infer<typeof registerBodySchema>;
type LoginInput = z.infer<typeof loginBodySchema>;
type ForgotPasswordInput = z.infer<typeof forgotPasswordBodySchema>;
type ResetPasswordInput = z.infer<typeof resetPasswordBodySchema>;

/** Nama dari metadata Google bisa kosong, terlalu pendek, atau terlalu panjang untuk kolom. */
export function resolveFullName(fullName: string | undefined, email: string): string {
  const candidates = [fullName, email.split('@')[0]];
  for (const candidate of candidates) {
    const name = candidate?.trim().slice(0, FULL_NAME_MAX).trim();
    if (name && name.length >= FULL_NAME_MIN) return name;
  }
  return FALLBACK_NAME;
}

export function createAuthService({ provider, repository }: AuthServiceDeps) {
  /**
   * Jalur bersama login password dan login Google. Supabase membuat baris auth.users di
   * setiap login, jadi yang membedakan pengguna baru hanyalah ada-tidaknya baris users.
   * Tidak ada kompensasi deleteUser di sini: akun Supabase-nya sah dan login berikutnya
   * mencoba provisioning lagi.
   */
  async function ensureProvisioned(identity: AuthIdentity): Promise<UserRecord> {
    const existing = await repository.findUserById(identity.id);
    if (existing) {
      if (existing.deletedAt) throw AppError.unauthorized('Akun ini sudah dihapus');
      return existing;
    }

    try {
      return await repository.provisionNewUser({
        id: identity.id,
        fullName: resolveFullName(identity.fullName, identity.email),
        avatarUrl: identity.avatarUrl ?? null,
        initialBalance: 0,
      });
    } catch (error) {
      if (!(error instanceof UserAlreadyProvisionedError)) throw error;
      // Dua login pertama yang bersamaan: yang kalah membaca hasil yang menang.
      const created = await repository.findUserById(identity.id);
      if (!created || created.deletedAt) throw error;
      return created;
    }
  }

  async function authResult(identity: AuthIdentity, session: AuthSession): Promise<AuthResultBody> {
    const user = await ensureProvisioned(identity);
    return { user: toUserProfile(user, identity.email), session };
  }

  return {
    /**
     * Urutan dipaksa oleh FK users.id -> auth.users(id): akun Supabase harus ada lebih dulu.
     * Konsekuensinya, kegagalan transaksi database meninggalkan akun Supabase yatim, jadi
     * dihapus lagi (best effort). Transaksinya sendiri menjamin tidak ada baris users,
     * accounts, atau categories yang tersisa.
     */
    async register(input: RegisterInput): Promise<AuthResultBody> {
      const { identity, session } = await provider.signUp({
        email: input.email,
        password: input.password,
        fullName: input.full_name,
      });

      try {
        if (!session) {
          throw new Error('Supabase tidak menerbitkan sesi saat register; matikan konfirmasi email di dashboard');
        }
        const user = await repository.provisionNewUser({
          id: identity.id,
          fullName: input.full_name,
          avatarUrl: null,
          initialBalance: input.initial_balance,
        });
        return { user: toUserProfile(user, identity.email), session };
      } catch (error) {
        try {
          await provider.deleteUser(identity.id);
        } catch (cleanupError) {
          logger.error(
            { err: cleanupError, userId: identity.id },
            'Gagal menghapus akun Supabase yatim setelah register gagal',
          );
        }
        throw error;
      }
    },

    async login(input: LoginInput): Promise<AuthResultBody> {
      const { identity, session } = await provider.signInWithPassword(input);
      return authResult(identity, session);
    },

    async loginWithGoogle(idToken: string): Promise<AuthResultBody> {
      const { identity, session } = await provider.signInWithGoogleIdToken(idToken);
      return authResult(identity, session);
    },

    refresh: (refreshToken: string): Promise<AuthSession> => provider.refreshSession(refreshToken),

    logout: (accessToken: string): Promise<void> => provider.signOut(accessToken),

    /** Selalu pesan yang sama; hanya gangguan layanan dan rate limit yang boleh terlihat. */
    async forgotPassword(input: ForgotPasswordInput): Promise<string> {
      try {
        await provider.sendPasswordReset(input.email);
      } catch (error) {
        if (error instanceof AppError && (error.code === 'RATE_LIMITED' || error.code === 'SERVICE_UNAVAILABLE')) {
          throw error;
        }
        logger.error({ err: error }, 'Permintaan reset password gagal');
      }
      return FORGOT_PASSWORD_MESSAGE;
    },

    resetPassword: (input: ResetPasswordInput): Promise<void> => provider.resetPassword(input.token, input.password),
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
