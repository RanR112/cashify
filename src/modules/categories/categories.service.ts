import type {
  CategoriesRepository,
  CategoryBody,
  CategoryRecord,
  CategoryType,
} from './categories.types.js';

/**
 * Register menyalin kategori sistem menjadi milik pengguna (API.md bagian 3), jadi kueri
 * `user_id IS NULL OR user_id = $1` mengembalikan keduanya. Per `type` + `slug` hanya satu
 * yang tampil, dan baris milik pengguna menang atas baris sistem. Pengguna tanpa salinan
 * (mis. dibuat sebelum kategori di-seed) tetap melihat kategori sistem.
 *
 * Urutan masukan dipertahankan; posisi sebuah slug ditentukan kemunculan pertamanya.
 */
export function mergeCategories(records: CategoryRecord[]): CategoryRecord[] {
  const bySlug = new Map<string, CategoryRecord>();
  for (const record of records) {
    const key = `${record.type}:${record.slug}`;
    const existing = bySlug.get(key);
    if (!existing || (existing.userId === null && record.userId !== null)) bySlug.set(key, record);
  }
  return [...bySlug.values()];
}

export function toCategoryBody(record: CategoryRecord): CategoryBody {
  return {
    id: record.id,
    name: record.name,
    type: record.type as CategoryBody['type'],
    icon: record.icon,
    color: record.color,
    is_system: record.userId === null,
  };
}

export function createCategoriesService(repository: CategoriesRepository) {
  return {
    async list(userId: string, type?: CategoryType): Promise<{ data: CategoryBody[] }> {
      const records = await repository.listVisibleTo(userId, type);
      return { data: mergeCategories(records).map(toCategoryBody) };
    },
  };
}

export type CategoriesService = ReturnType<typeof createCategoriesService>;
