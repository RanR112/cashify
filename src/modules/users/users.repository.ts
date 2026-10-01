import type { Prisma, PrismaClient } from '@prisma/client';
import { requireUserId } from '../../shared/utils/userScope.js';
import type { ProfilePatch, UsersRepository } from './users.types.js';

const userSelect = {
  id: true,
  fullName: true,
  avatarUrl: true,
  initialBalance: true,
  currency: true,
  timezone: true,
  locale: true,
  onboardingCompletedAt: true,
  createdAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

/** Tabel users memakai `id` sebagai kunci pemilik, jadi filternya `id = userId`, bukan `user_id`. */
const activeUser = (userId: string) => ({ id: requireUserId(userId), deletedAt: null });

export function createUsersRepository(prisma: PrismaClient): UsersRepository {
  return {
    findById: (userId) => prisma.user.findFirst({ where: activeUser(userId), select: userSelect }),

    async updateProfile(userId: string, patch: ProfilePatch) {
      const where = activeUser(userId);
      // Satu pernyataan UPDATE dengan filter pemilik; count 0 berarti tidak ada baris aktif.
      const { count } = await prisma.user.updateMany({ where, data: patch });
      if (count === 0) return null;
      return prisma.user.findFirst({ where, select: userSelect });
    },
  };
}
