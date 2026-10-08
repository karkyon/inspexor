import { test, expect, type Page } from '@playwright/test';

// G2-E2E: SCR-13 マスター管理（API-015〜018 を画面から）。前提: dev-admin と synthetic seed（SYN-*）が投入済み。
// 作成する作業者は 0E2E-<逆順時刻> の一意コードで作り、最後に無効化して後始末する（物理削除はしない＝仕様）。
const LOGIN_ID = process.env['E2E_LOGIN_ID'] ?? 'dev-admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(LOGIN_ID);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('G2-E2E: SCR-13 マスター管理', () => {
  test.beforeAll(() => {
    if (PASSWORD.length === 0) throw new Error('E2E_PASSWORD が未設定です');
  });

  test('未ログインで管理画面を開くと /login へ', async ({ page }) => {
    await page.goto('/admin/masters/products');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('ホーム → マスター管理 → 品番一覧（seed 表示・種別切替）', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'マスター管理へ' }).click();
    await expect(page).toHaveURL(/\/admin\/masters\/products$/);
    await expect(page.getByRole('heading', { level: 1, name: 'マスター管理' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'SYN-P01', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'マスター種別' }).getByRole('link', { name: /作業者/ }).click();
    await expect(page).toHaveURL(/\/admin\/masters\/workers$/);
    await expect(page.getByRole('link', { name: '＋ 作業者を追加' })).toBeVisible();
  });

  test('作業者: 追加 → 重複は項目エラー → 編集（理由必須）→ 無効化', async ({ page }) => {
    // 一覧はコード昇順・25件/頁のため、新しいものほど先頭に来るよう「逆順タイムスタンプ」を使う
    const code = `0E2E-${9_999_999_999_999 - Date.now()}`;
    await login(page);

    await page.goto('/admin/masters/workers/new');
    await page.getByRole('button', { name: '登録する' }).click();
    const summary = page.getByRole('alert').filter({ hasText: '入力内容を確認してください' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('必須項目です。');
    await expect(summary).toBeFocused();

    await page.getByLabel(/^コード/).fill(code);
    await page.getByLabel('氏名').fill('E2E 作業者');
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page).toHaveURL(/\/admin\/masters\/workers\?saved=created$/);
    await expect(page.getByRole('status').filter({ hasText: '登録しました。' })).toBeVisible();

    // 同じコードは 422（一意制約）→ コード欄に紐づくエラー
    await page.goto('/admin/masters/workers/new');
    await page.getByLabel(/^コード/).fill(code);
    await page.getByLabel('氏名').fill('重複');
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByLabel(/^コード/)).toHaveAttribute('aria-invalid', 'true');

    // 一覧 → 編集
    await page.goto('/admin/masters/workers');
    await page.getByLabel('表示中のページ内を検索').fill(code);
    await page.getByRole('link', { name: `${code} を編集` }).click();
    await expect(page.getByRole('heading', { level: 1, name: /作業者の編集/ })).toBeVisible();
    await page.getByLabel('氏名').fill('E2E 作業者（改）');
    await page.getByRole('button', { name: '変更を保存' }).click();
    await expect(page.getByLabel('変更理由')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('変更理由').fill('E2E: 氏名の表記修正');
    await page.getByRole('button', { name: '変更を保存' }).click();
    await expect(page).toHaveURL(/saved=updated$/);

    // 無効化（確認ダイアログ: 影響表示 → 実行）
    await page.getByLabel('表示中のページ内を検索').fill(code);
    await page.getByRole('link', { name: `${code} を編集` }).click();
    await expect(page.getByRole('heading', { level: 1, name: /作業者の編集/ })).toBeVisible();
    await page.getByRole('button', { name: '無効化', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '作業者を無効化しますか？' });
    await expect(dialog.getByText('過去の期間には影響しません')).toBeVisible();
    await dialog.getByRole('button', { name: '無効化する' }).click();
    await expect(page).toHaveURL(/saved=deactivated$/);
    await page.getByLabel('状態で絞り込み').selectOption('inactive');
    await page.getByLabel('表示中のページ内を検索').fill(code);
    await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  });

  test('単価ルール: 影響を確認（遡及は警告表示・保存はしない）', async ({ page }) => {
    await login(page);
    await page.goto('/admin/masters/rates');
    await page.getByRole('link', { name: /を編集$/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: /単価ルールの編集/ })).toBeVisible();
    await page.getByRole('button', { name: '影響を確認' }).click();
    await expect(page.getByRole('status').filter({ hasText: '過去の期間に影響する変更です' })).toBeVisible();
    await expect(page.getByText('確定済みの請求書は変更されません')).toBeVisible();
  });

  test('事務(OFFICE)ロールは参照のみ（追加ボタンなし）', async ({ page }) => {
    test.skip(process.env['E2E_OFFICE_PASSWORD'] === undefined, 'OFFICE ユーザー未用意の環境ではスキップ');
    await page.goto('/login');
    await page.getByLabel('ログインID').fill(process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office');
    await page.getByLabel('パスワード').fill(process.env['E2E_OFFICE_PASSWORD'] ?? '');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/admin/masters/products');
    await expect(page.getByText('参照のみ（編集は管理者）')).toBeVisible();
    await expect(page.getByRole('link', { name: /を追加$/ })).toHaveCount(0);
  });
});
