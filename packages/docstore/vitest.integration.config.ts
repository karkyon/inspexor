import { defineConfig } from 'vitest/config';

// 結合試験（*.itest.ts）。FIRESTORE_EMULATOR_HOST があれば Firestore エミュレータ、無ければ MemoryDocStore で実行する。
export default defineConfig({
  test: {
    include: ['src/**/*.itest.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
