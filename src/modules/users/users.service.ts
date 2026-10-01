import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.js';
import { toUserProfile } from '../../shared/mappers/userProfile.js';
import type { updateMeBodySchema } from './users.schema.js';
import type { ProfilePatch, UserProfile, UsersRepository } from './users.types.js';

type UpdateMeInput = z.infer<typeof updateMeBodySchema>;

const NOT_FOUND_MESSAGE = 'Profil tidak ditemukan';

/** `undefined` berarti "tidak diubah"; `null` pada avatar berarti "hapus". */
function toPatch(input: UpdateMeInput): ProfilePatch {
  return {
    ...(input.full_name !== undefined && { fullName: input.full_name }),
    ...(input.avatar_url !== undefined && { avatarUrl: input.avatar_url }),
    ...(input.initial_balance !== undefined && { initialBalance: input.initial_balance }),
  };
}

export function createUsersService(repository: UsersRepository) {
  return {
    /** `email` dari klaim JWT: kredensial ada di Supabase Auth, bukan di tabel users. */
    async getMe(userId: string, email: string): Promise<UserProfile> {
      const user = await repository.findById(userId);
      if (!user) throw AppError.notFound(NOT_FOUND_MESSAGE);
      return toUserProfile(user, email);
    },

    async updateMe(userId: string, email: string, input: UpdateMeInput): Promise<UserProfile> {
      const user = await repository.updateProfile(userId, toPatch(input));
      if (!user) throw AppError.notFound(NOT_FOUND_MESSAGE);
      return toUserProfile(user, email);
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
