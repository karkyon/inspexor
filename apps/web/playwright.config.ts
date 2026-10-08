import { defineConfig, devices } from '@playwright/test';

// G0-E2E: 起動中のdevサーバー（http://localhost:3000）に対して実行する。
// 未起動なら `pnpm dev` を自動起動する（DB接続は cloud-sql-proxy 前提）。
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  retries: 0,
  // dev-admin 1アカウント・開発DB 1つを共有するため直列（ロック回数・作成データの干渉を防ぐ）
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
