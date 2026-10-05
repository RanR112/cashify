import type { z } from 'zod';
import type { categorySchema, listCategoriesQuerySchema } from './categories.schema.js';

export type CategoryBody = z.infer<typeof categorySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export type CategoryType = NonNullable<ListCategoriesQuery['type']>;

export interface CategoryRecord {
  id: string;
  /** NULL berarti kategori sistem. */
  userId: string | null;
  name: string;
  slug: string;
  type: string;
  icon: string;
  color: string;
  sortOrder: number;
}

/** Kategori beserta kata kuncinya: kamus parser WhatsApp. Terpisah dari `CategoryRecord` agar kata kunci tidak ikut ke response API. */
export interface CategoryWithKeywords extends CategoryRecord {
  keywords: string[];
}

/** Semua metode menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface CategoriesRepository {
  /** Kategori sistem DAN milik pengguna: `user_id IS NULL OR user_id = $1`. */
  listVisibleTo(userId: string, type?: CategoryType): Promise<CategoryRecord[]>;
  /** Seperti `listVisibleTo` (kedua tipe), tetapi memuat `keywords`. */
  listWithKeywords(userId: string): Promise<CategoryWithKeywords[]>;
}
