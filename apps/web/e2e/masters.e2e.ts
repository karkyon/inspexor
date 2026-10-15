import { login as authLogin } from './auth';
import { test, expect, type Page } from '@playwright/test';

// G2-E2E: SCR-13 マスター管理（API-015〜018 を画面から）。前提: dev-admin と synthetic seed（SYN-*）が投入済み。
// 作成する作業者は 0E2E-<逆順時刻> の一意コードで作り、最後に無効化して後始末する（物理削除はしない＝仕様）。
const LOGIN_ID = process.env['E2E_LOGIN_ID'] ?? 'dev-admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

async function login(page: Page): Promise<void> {
  await authLogin(page, LOGIN_ID, PASSWORD);
}

async function billingEnabled(page: Page): Promise<boolean> {
  const me = (await (await page.request.get('/api/v1/me')).json()) as { data?: { features?: { billing?: boolean } } };
  return me.data?.features?.billing === true;
}

/** 2100年以降で実行ごとに異なる日（既存ルールと期間が重ならないように） */
function uniqueFarDate(): string {
  const d = new Date(Date.UTC(2100, 0, 1) + (Math.floor(Date.now() / 1000) % 36_000) * 86_400_000);
  return d.toISOString().slice(0, 10);
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

  test('CHG-004: メニューは提案書の範囲（車両・作業場所あり、請求・メール系なし）、車両を追加', async ({ page }) => {
    const code = `0E2E-V${9_999_999_999_999 - Date.now()}`;
    await login(page);
    await page.goto('/admin/masters/products');
    const nav = page.getByRole('navigation', { name: 'マスター種別' });
    await expect(nav.getByRole('link', { name: /車両/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /作業場所/ })).toBeVisible();
    // CHG-009: 請求マスタは請求機能（BILLING_ENABLED）が有効なときだけ表示
    const billing = await billingEnabled(page);
    for (const hidden of [/単価ルール/, /運搬ルール/, /固定費/]) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(billing ? 1 : 0);
    await expect(nav.getByRole('link', { name: /お客様担当者/ })).toBeVisible(); // CHG-005: 日報の担当者欄
    await nav.getByRole('link', { name: /車両/ }).click();
    await expect(page).toHaveURL(/\/admin\/masters\/vehicles$/);
    await expect(page.getByRole('cell', { name: 'SYN-V01', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '＋ 車両を追加' }).click();
    await page.getByLabel(/^コード/).fill(code);
    await page.getByLabel('車両名').fill('E2E 車両');
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page).toHaveURL(/\/admin\/masters\/vehicles\?saved=created$/);
    await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  });

  test('CHG-009: 請求機能が有効なら単価ルールを追加 → 期間の重なりは項目エラー → 無効化', async ({ page }) => {
    await login(page);
    test.skip(!(await billingEnabled(page)), '請求機能（BILLING_ENABLED）が無効の環境ではスキップ');
    const day = uniqueFarDate();
    await page.goto('/admin/masters/rates');
    await expect(page.getByRole('heading', { level: 1, name: 'マスター管理' })).toBeVisible();
    for (let i = 0; i < 2; i += 1) {
      await page.goto('/admin/masters/rates/new');
      await page.getByLabel(/^品番/).selectOption({ label: 'SYN-P01 合成品番01（運搬対象）' });
      await page.getByLabel(/^単価/).fill('4.4');
      await page.getByLabel(/^適用開始日/).fill(day);
      await page.getByLabel(/^適用終了日/).fill(day);
      await page.getByRole('button', { name: '登録する' }).click();
      if (i === 0) await expect(page).toHaveURL(/\/admin\/masters\/rates\?saved=created$/);
    }
    // 2件目は同じ品番・全作業・同じ期間のため 422（適用期間の重なり）
    await expect(page.getByLabel(/^適用開始日/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.ix-errorsummary')).toContainText('重なっています');
    // 後始末: 1件目を無効化
    const list = (await (await page.request.get('/api/v1/masters/rates?pageSize=100')).json()) as { data: Array<{ id: string; validFrom: string; active: boolean }> };
    const created = list.data.find((r) => r.validFrom === day && r.active);
    expect(created).toBeDefined();
    await page.goto(`/admin/masters/rates/${created?.id ?? ''}`);
    await page.getByRole('button', { name: '無効化', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/理由/).fill('E2E の後片付け');
    await dialog.getByRole('button', { name: '無効化する' }).click();
    await expect(page).toHaveURL(/saved=deactivated$/);
  });

  // CHG-006 F1: 単価ルール（請求専用マスタ）は Firestore に移行しない（Blind）ため、影響確認の E2E は削除
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
