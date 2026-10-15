import { test, expect } from '@playwright/test';
import { hotp, login } from './auth';

// CHG-012 E2E: 管理者の多要素認証（ADMIN_MFA_ENABLED=true の開発環境）。
//   E2E 専用の管理者を作る → 初回ログインで登録（QR・秘密鍵・誤ったコード・回復コード10個）→ 確認コードでログイン
//   → 回復コードでログイン → アカウント画面で回復コードを再発行 → dev-admin が解除 → その session は使えず、次は登録から → 後片付け（無効化）
const ADMIN_PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const MAIN = process.env['E2E_LOGIN_ID'] ?? 'dev-admin';

test.describe('CHG-012 E2E: 管理者の多要素認証', () => {
  test.beforeAll(() => {
    if (ADMIN_PASSWORD === '') throw new Error('E2E_PASSWORD が未設定です');
  });

  test('登録 → 確認コード → 回復コード → 再発行 → 他の管理者による解除', async ({ page, browser }) => {
    test.setTimeout(300_000);
    const csrf = await login(page, MAIN, ADMIN_PASSWORD);
    const me = ((await (await page.request.get('/api/v1/me')).json()) as { data: { features: { adminMfa?: boolean } } }).data;
    test.skip(me.features.adminMfa !== true, '管理者の多要素認証（ADMIN_MFA_ENABLED）が無効の環境ではスキップ');

    const loginId = `e2e.mfa${Date.now()}`;
    const pw = 'E2e-mfa-password-1';
    const created = await page.request.post('/api/v1/users', { headers: { 'x-csrf-token': csrf }, data: { loginId, displayName: 'E2E 管理者', roles: ['ADMIN'], password: pw } });
    expect(created.status()).toBe(201);
    const userId = ((await created.json()) as { data: { id: string } }).data.id;

    // ---- 初回ログイン: 登録
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await other.goto('/login');
    await other.getByLabel('ログインID').fill(loginId);
    await other.getByLabel('パスワード').fill(pw);
    await other.getByRole('button', { name: 'ログイン' }).click();
    await expect(other.getByRole('heading', { name: '多要素認証の登録' })).toBeVisible();
    await expect(other.getByRole('img', { name: '認証アプリに登録する QR コード' })).toBeVisible();
    const secret = ((await other.getByTestId('mfa-secret').textContent()) ?? '').replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await other.getByLabel('確認コード（6桁）').fill('000000');
    await other.getByRole('button', { name: '登録してログイン' }).click();
    await expect(other.locator('form [role="alert"]')).toContainText('確認コードが正しくありません');
    const step = Math.floor(Date.now() / 30_000);
    await other.getByLabel('確認コード（6桁）').fill(hotp(secret, step));
    await other.getByRole('button', { name: '登録してログイン' }).click();
    const list = other.getByTestId('mfa-recovery-codes').getByRole('listitem');
    await expect(list).toHaveCount(10);
    const codes = (await list.allTextContents()).map((c) => c.trim());
    await expect(other.getByRole('button', { name: '続ける' })).toBeDisabled();
    await other.getByLabel('回復コードを安全な場所に保存しました').check();
    await other.getByRole('button', { name: '続ける' }).click();
    await expect(other.getByText(/ようこそ、E2E 管理者さん（ADMIN）/)).toBeVisible();

    // ---- ログアウト → 確認コードでログイン（同じ区間のコードは使えないので次の区間）
    await other.getByRole('button', { name: 'ログアウト' }).click();
    await other.goto('/login');
    await other.getByLabel('ログインID').fill(loginId);
    await other.getByLabel('パスワード').fill(pw);
    await other.getByRole('button', { name: 'ログイン' }).click();
    await expect(other.getByRole('heading', { name: '確認コードの入力' })).toBeVisible();
    const next = step + 1;
    const wait = (next - 1) * 30_000 - Date.now() + 1000;
    if (wait > 0) await other.waitForTimeout(wait);
    await other.getByLabel('確認コード（6桁）').fill(hotp(secret, Math.max(next, Math.floor(Date.now() / 30_000))));
    await other.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(other.getByText(/ようこそ、E2E 管理者さん（ADMIN）/)).toBeVisible();

    // ---- 回復コードでログイン
    await other.getByRole('button', { name: 'ログアウト' }).click();
    await other.goto('/login');
    await other.getByLabel('ログインID').fill(loginId);
    await other.getByLabel('パスワード').fill(pw);
    await other.getByRole('button', { name: 'ログイン' }).click();
    await other.getByRole('button', { name: '認証アプリを使えない（回復コードを使う）' }).click();
    await other.getByLabel('回復コード').fill(codes[0] as string);
    await other.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(other.getByText(/ようこそ、E2E 管理者さん（ADMIN）/)).toBeVisible();

    // ---- アカウント画面: 残り9個 → 再発行（ログイン直後なので本人確認は不要）
    await other.goto('/admin/account');
    await expect(other.getByRole('heading', { level: 1, name: '多要素認証' })).toBeVisible();
    await expect(other.getByText('9個')).toBeVisible();
    await other.getByRole('button', { name: '回復コードを再発行' }).click();
    await expect(other.getByTestId('mfa-recovery-codes').getByRole('listitem')).toHaveCount(10);
    await expect(other.getByText('10個')).toBeVisible();

    // ---- dev-admin が解除 → その利用者の session は使えない → 次のログインは登録から
    await page.goto(`/admin/users/${userId}`);
    await expect(page.getByRole('heading', { level: 2, name: '多要素認証' })).toBeVisible();
    await expect(page.getByRole('button', { name: '多要素認証を解除' })).toBeDisabled();
    await page.getByLabel(/^解除の理由/).fill('E2E: 端末の紛失');
    await page.getByRole('button', { name: '多要素認証を解除' }).click();
    await expect(page.getByRole('status')).toContainText('多要素認証を解除しました');
    await expect.poll(async () => (await other.request.get('/api/v1/me')).status(), { timeout: 60_000, intervals: [2000, 5000] }).toBe(401);
    await other.goto('/login');
    await other.getByLabel('ログインID').fill(loginId);
    await other.getByLabel('パスワード').fill(pw);
    await other.getByRole('button', { name: 'ログイン' }).click();
    await expect(other.getByRole('heading', { name: '多要素認証の登録' })).toBeVisible();
    await ctx.close();

    // ---- 後片付け: 無効化（記録は残る）
    const u = ((await (await page.request.get('/api/v1/users')).json()) as { data: Array<{ id: string; version: number }> }).data.find((x) => x.id === userId);
    const off = await page.request.post(`/api/v1/users/${userId}/deactivate`, { headers: { 'x-csrf-token': csrf }, data: { expectedVersion: u?.version, reason: 'E2E の後片付け' } });
    expect(off.status()).toBe(200);
  });
});
