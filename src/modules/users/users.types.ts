import type { UserRecord } from '../../shared/types/user.js';

export type { UserProfile, UserRecord } from '../../shared/types/user.js';

/** Field yang boleh diubah lewat PATCH /me, sudah dalam nama kolom Prisma. */
export interface ProfilePatch {
  fullName?: string;
  avatarUrl?: string | null;
  initialBalance?: number;
}

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface UsersRepository {
  findById(userId: string): Promise<UserRecord | null>;
  /** Null bila pengguna tidak ada atau sudah di-soft-delete. */
  updateProfile(userId: string, patch: ProfilePatch): Promise<UserRecord | null>;
}
