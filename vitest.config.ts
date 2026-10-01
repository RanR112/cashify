import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Menyiapkan Postgres test (bila menyala) sekali sebelum seluruh test.
    globalSetup: ['tests/integration/global-setup.ts'],
    // Semua test integrasi memakai satu database dan saling menghapus data (resetUserData),
    // jadi berkasnya harus berjalan berurutan.
    fileParallelism: false,
  },
});
