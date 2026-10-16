import { login } from './auth';
import { test, expect } from '@playwright/test';

// CHG-008 E2E: 利用者管理（ADMIN）。追加 → 新しい利用者でログイン → ロール変更・無効化で既存セッションが使えなくなる → 再有効化・パスワード再設定。
// 前提: dev-admin（ADMIN）。作成した利用者は最後に無効にする（開発DBに残る）。
const ADMIN_PASSWORD = process.env['E2E_PASSWORD'] ?? '';


test.describe('CHG-008 E2E: 利用者管理', () => {
  test.beforeAll(() => {
    if (ADMIN_PASSWORD === '') throw new Error('E2E_PASSWORD が未設定です');
  });

  test('追加 → ログイン → ロール変更で再ログインが必要 → 無効化 → 有効化・パスワード再設定', async ({ page, browser }) => {
    test.setTimeout(180_000);
    const loginId = `e2e.user${Date.now()}`;
    const pw1 = 'E2e-password-first';
    const pw2 = 'E2e-password-second';
    await login(page, process.env['E2E_LOGIN_ID'] ?? 'dev-admin', ADMIN_PASSWORD);
    await page.getByRole('link', { name: '報告一覧へ（事務所）' }).click();
    await page.getByRole('complementary', { name: 'メインメニュー' }).getByRole('link', { name: /利用者管理/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: '利用者管理' })).toBeVisible();
    await page.getByRole('link', { name: '＋ 利用者を追加' }).click();
    // 入力不足はエラー表示
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page.locator('.ix-errorsummary')).toContainText('入力内容を確認してください');
    await page.getByLabel(/^ログインID/).fill(loginId);
    await page.getByLabel(/^表示名/).fill('E2E 利用者');
    await page.getByLabel(/^パスワード/).fill(pw1);
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page).toHaveURL(/\/admin\/users\?saved=created$/);
    await expect(page.getByRole('status')).toContainText('利用者を追加しました');
    const row = page.getByRole('row').filter({ hasText: loginId });
    await expect(row).toContainText('現場');
    await expect(row).toContainText('有効');

    // 新しい利用者（現場）でログインできる
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await login(other, loginId, pw1);
    await expect(other.getByText(/ようこそ、E2E 利用者さん（現場）/)).toBeVisible();
    expect((await other.request.get('/api/v1/me')).status()).toBe(200);

    // ロールを変更すると、その利用者の既存セッションは使えない（再ログインが必要）
    await row.getByRole('link', { name: loginId }).click();
    await page.getByRole('checkbox', { name: /事務/ }).check();
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByRole('status')).toContainText('保存しました');
    await expect.poll(async () => (await other.request.get('/api/v1/me')).status(), { timeout: 60_000, intervals: [2000, 5000] }).toBe(401);

    // 無効化 → ログインできない。有効化 + パスワード再設定 → 新しいパスワードでログイン
    await page.getByLabel(/^理由/).fill('E2E の後片付け');
    await page.getByRole('button', { name: '無効にする' }).click();
    await expect(page.getByRole('status')).toContainText('無効にしました');
    await expect(page.locator('.ix-pagehead')).toContainText('無効');
    await other.goto('/login');
    await other.getByLabel('ログインID').fill(loginId);
    await other.getByLabel('パスワード').fill(pw1);
    await other.getByRole('button', { name: 'ログイン' }).click();
    await expect(other.locator('form [role="alert"]')).toHaveText('ログインIDまたはパスワードが正しくありません。');
    await page.getByRole('button', { name: '有効にする' }).click();
    await expect(page.getByRole('status')).toContainText('有効にしました');
    await page.locator('#u-pw').fill(pw2);
    await page.getByRole('button', { name: 'パスワードを再設定' }).click();
    await expect(page.getByRole('status')).toContainText('パスワードを再設定しました');
    await login(other, loginId, pw2);
    await expect(other.getByText(/ようこそ、E2E 利用者さん（現場・事務所）/)).toBeVisible();

    // 後片付け: 無効にする
    await page.getByRole('button', { name: '無効にする' }).click();
    await expect(page.getByRole('status')).toContainText('無効にしました');
    await ctx.close();
  });
});
