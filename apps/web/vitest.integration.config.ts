import { defineConfig } from 'vitest/config';

// 統合テスト（*.itest.ts）。CHG-006: FIRESTORE_EMULATOR_HOST があれば Firestore エミュレータ、無ければ MemoryDocStore で実行する。
export default defineConfig({
  test: {
    include: ['**/*.itest.ts'],
    exclude: ['node_modules/**', '.next/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
