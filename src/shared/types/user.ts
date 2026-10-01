// Bentuk profil pengguna yang dipakai `auth` dan `users`. Modul tidak boleh saling impor,
// jadi tipe bersama hidup di sini.

import type { z } from 'zod';
import type { userProfileSchema } from '../schemas/user.schema.js';

export type UserProfile = z.infer<typeof userProfileSchema>;

export interface UserRecord {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  initialBalance: number;
  currency: string;
  timezone: string;
  locale: string;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}
