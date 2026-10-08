import { defineConfig } from 'vitest/config';

// 統合テスト（*.itest.ts）。実PostgreSQLが必要: ITEST_DATABASE_URL を設定して実行する。
export default defineConfig({
  test: {
    include: ['**/*.itest.ts'],
    exclude: ['node_modules/**', '.next/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
