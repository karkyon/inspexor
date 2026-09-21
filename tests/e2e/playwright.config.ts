import { defineConfig } from "@playwright/test";

// INSPEXOR_テスト・受入仕様書_v5.1.md: 15画面 × role × responsive を対象とする。
// 個別テストはG0-E2E以降で追加し、skipは禁止（開発スタック定義書 5章）。
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: process.env.APP_ORIGIN ?? "http://localhost:3000",
  },
});
