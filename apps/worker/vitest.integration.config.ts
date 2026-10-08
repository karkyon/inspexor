import { defineConfig } from 'vitest/config';

// worker 統合試験: 実 PostgreSQL（ITEST_DATABASE_URL）＋ 実 Chromium ＋ Mailpit（MAILPIT_URL）
export default defineConfig({
  test: {
    include: ['src/**/*.itest.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
