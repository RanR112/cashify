import type { z } from 'zod';
import type { accountSchema } from './accounts.schema.js';

export type AccountBody = z.infer<typeof accountSchema>;

export interface AccountRecord {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
}

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface AccountsRepository {
  listByUser(userId: string): Promise<AccountRecord[]>;
}
