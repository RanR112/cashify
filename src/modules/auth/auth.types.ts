import type { z } from 'zod';
import type { AuthSession } from '../../lib/auth.js';
import type { authResultSchema } from '../../shared/schemas/user.schema.js';
import type { UserRecord } from '../../shared/types/user.js';

export type { UserProfile, UserRecord } from '../../shared/types/user.js';
export type AuthResultBody = z.infer<typeof authResultSchema>;

export interface ProvisionInput {
  /** Sama dengan auth.users.id. */
  id: string;
  fullName: string;
  avatarUrl: string | null;
  initialBalance: number;
}

export interface AuthRepository {
  findUserById(id: string): Promise<UserRecord | null>;
  /**
   * Satu transaksi: baris users, akun default "Tunai", salinan kategori sistem.
   * Melempar `UserAlreadyProvisionedError` bila baris users untuk id itu sudah ada.
   */
  provisionNewUser(input: ProvisionInput): Promise<UserRecord>;
}

export type { AuthSession };
