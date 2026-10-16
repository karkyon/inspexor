import { test, expect } from '@playwright/test';
import { finishMfa } from './auth';

// 前提: dev-admin が seed 済み。パスワードは環境変数 E2E_PASSWORD（~/.inspexor-dev-admin-password から渡す）。
const LOGIN_ID = process.env['E2E_LOGIN_ID'] ?? 'dev-admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

test.describe('G0-E2E: 認証フロー（API-001/002/003）', () => {
  test.beforeAll(() => {
    if (PASSWORD.length === 0) {
      throw new Error('E2E_PASSWORD が未設定です');
    }
  });

  test('誤パスワードはエラー表示（存在秘匿メッセージ）', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('ログインしてください。')).toBeVisible();
    await page.getByLabel('ログインID').fill(LOGIN_ID);
    await page.getByLabel('パスワード').fill('wrong-password-123');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.locator('form [role="alert"]')).toHaveText('ログインIDまたはパスワードが正しくありません。');
  });

  test('ログイン → 再読込でセッション維持 → ログアウト', async ({ page, context }) => {
    await page.goto('/');
    await page.getByLabel('ログインID').fill(LOGIN_ID);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await finishMfa(page, LOGIN_ID);
    await expect(page.getByText(/ようこそ、.+さん（管理者）/)).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === '__Secure-inspexor.session');
    expect(session, 'session cookieが発行されていない').toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    await page.reload();
    await expect(page.getByText(/ようこそ、.+さん（管理者）/)).toBeVisible();

    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page.getByText('ログインしてください。')).toBeVisible();

    await page.reload();
    await expect(page.getByText('ログインしてください。')).toBeVisible();
  });

  test('/login 画面からログインすると / へ遷移', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('ログインID').fill(LOGIN_ID);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await finishMfa(page, LOGIN_ID);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/ようこそ、.+さん（管理者）/)).toBeVisible();
  });

  test('CSRFトークン無しのlogout APIは403', async ({ page, request }) => {
    await page.goto('/');
    await page.getByLabel('ログインID').fill(LOGIN_ID);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await finishMfa(page, LOGIN_ID);
    await expect(page.getByText(/ようこそ/)).toBeVisible();
    const res = await page.request.post('/api/v1/auth/logout');
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CSRF_INVALID');
    const anon = await request.post('/api/v1/auth/logout');
    expect(anon.status()).toBe(401);
  });
});
