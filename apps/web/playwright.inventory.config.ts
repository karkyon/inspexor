import { defineConfig, devices } from '@playwright/test';

// 在庫管理のブラウザ E2E（CHG-018）。メモリ上の DocStore で Next を起動し、app/api/e2e-seed で初期データを入れる。
// 実行: npx playwright test --config playwright.inventory.config.ts
const PORT = 3100;
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/inventory.e2e.ts',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...(process.env['E2E_CHROME_PATH'] ? { launchOptions: { executablePath: process.env['E2E_CHROME_PATH'] } } : {}) },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      E2E_MEMORY_STORE: '1',
      APP_ENV: 'local',
      INVENTORY_ENABLED: 'true',
      AUTH_SECRET: 'e2e-auth-secret-e2e-auth-secret-e2e-auth-secret',
      E2E_SEED_PASSWORD: process.env['E2E_SEED_PASSWORD'] ?? 'E2e-Passw0rd-Inv!',
      BUSINESS_TIMEZONE: 'Asia/Tokyo',
    },
  },
});
