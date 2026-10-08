import { test, expect, type Page } from '@playwright/test';

// G3-E2E: SCR-02〜09 現場入力（API-004〜012）。前提: dev-field（FIELD）と synthetic seed（SYN-*）が投入済み。
// 作成した実績は確定（CONFIRMED）まで進む。確定実績は不変（仕様）のため削除しない（開発DBに残る）。
const LOGIN_ID = process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field';
const PASSWORD = process.env['E2E_FIELD_PASSWORD'] ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(LOGIN_ID);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('G3-E2E: 現場入力（SCR-02〜09）', () => {
  test.beforeAll(() => {
    if (PASSWORD.length === 0) throw new Error('E2E_FIELD_PASSWORD が未設定です');
  });

  test('未ログインで現場画面を開くと /login へ', async ({ page }) => {
    await page.goto('/field');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('SCR-03〜05 運搬: 入力エラー → 3 step → 確認チェック必須 → 確定 → 現場ホームの最近の登録に表示', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: '現場入力へ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /お疲れさまです/ })).toBeVisible();
    await page.getByRole('link', { name: /運搬実績を登録/ }).click();
    await expect(page).toHaveURL(/\/field\/deliveries\/new\?step=1$/);

    // Step1: 未選択で次へ → error summary（focus）
    await page.getByRole('button', { name: '次へ進む →' }).click();
    const summary = page.getByRole('alert').filter({ hasText: '入力内容を確認してください' });
    await expect(summary).toBeFocused();
    await expect(page.getByLabel(/^運転者/)).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel(/^運搬日/).fill('2026-10-08');
    await page.getByLabel(/^運転者/).selectOption({ label: 'SYN-W03 合成運転者' });
    await page.getByLabel(/^お客様/).selectOption({ label: 'SYN-C01 合成顧客A' });
    await page.getByRole('button', { name: '次へ進む →' }).click();

    // Step2: 品番選択と数量
    await expect(page).toHaveURL(/step=2$/);
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '品番を1件以上選択してください。' })).toBeVisible();
    await page.getByRole('checkbox', { name: /^SYN-P01/ }).check();
    await page.getByLabel('SYN-P01 の数量').fill('1200');
    await page.getByRole('checkbox', { name: /^SYN-P02/ }).check();
    await page.getByLabel('SYN-P02 の数量').fill('800');
    await expect(page.getByText('2,000個')).toBeVisible();

    // 再読込しても端末下書きが残る（REQ-OFF-001）
    await page.waitForTimeout(1300);
    await page.reload();
    await expect(page.getByLabel('SYN-P01 の数量')).toHaveValue('1200');
    await page.getByRole('button', { name: '次へ進む →' }).click();

    // Step3: 確認チェック必須
    await expect(page.getByRole('heading', { level: 1, name: '登録内容を確認' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1,200個' })).toBeVisible();
    await page.getByRole('button', { name: '確定して登録' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '「内容を確認しました」にチェックしてください。' })).toBeVisible();
    await page.getByLabel('内容を確認しました').check();
    await page.getByRole('button', { name: '確定して登録' }).click();
    const done = page.getByRole('status').filter({ hasText: '運搬実績を登録しました' });
    await expect(done).toBeVisible();
    const reportNo = (await done.locator('b').first().textContent()) ?? '';
    expect(reportNo).toMatch(/^DR-\d{6}-\d{6}$/);

    // 確定後は端末下書きが消え、ホームの最近の登録に出る
    await page.getByRole('link', { name: '現場ホームへ' }).click();
    await expect(page.getByText(reportNo)).toBeVisible();
    await expect(page.getByRole('link', { name: /運搬実績の下書きを再開/ })).toHaveCount(0);
  });

  test('SCR-06〜09 作業: 5 step（工数の即時計算・不良・良品数）→ 確定', async ({ page }) => {
    await login(page);
    await page.goto('/field/work-reports/new?step=1');
    await expect(page.getByLabel('報告者')).toHaveValue(/（本人）$/);
    await page.getByRole('textbox', { name: /^作業日/ }).fill('2026-10-08'); // 平日（木）
    await page.getByLabel(/^お客様/).selectOption({ label: 'SYN-C01 合成顧客A' });
    await page.getByRole('button', { name: '次へ進む →' }).click();

    await expect(page).toHaveURL(/step=2$/);
    await page.getByLabel(/^品番/).selectOption({ label: 'SYN-P05 合成品番05（時間精算）' });
    await expect(page.getByLabel('品名')).toHaveValue('合成品番05（時間精算）');
    await page.getByLabel(/^作業内容/).selectOption({ label: 'INSP 検査' });
    await page.getByLabel(/^ロット番号/).fill('LOT-E2E-1');
    await page.getByRole('button', { name: '次へ進む →' }).click();

    await expect(page).toHaveURL(/step=3$/);
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '作業者を1名以上選択してください。' })).toBeVisible();
    await page.getByLabel('SYN-W01 合成作業者1').check();
    await page.getByLabel('SYN-W02 合成作業者2').check();
    await page.getByLabel(/^開始時刻/).fill('13:00');
    await page.getByLabel(/^終了時刻/).fill('18:00');
    // 13:00–18:00 × 2名: 通常 8.0 人時、割増 2.0 人時（17時以降）
    const calc = page.locator('.fx-timecalc');
    await expect(calc).toContainText('8.0人時');
    await expect(calc).toContainText('2.0人時');
    await page.getByRole('button', { name: '次へ進む →' }).click();

    await expect(page).toHaveURL(/step=4$/);
    await page.getByLabel(/^処理数量/).fill('1600');
    await page.getByLabel('バリ').fill('8');
    await page.getByLabel('欠け').fill('4');
    await expect(page.getByLabel('良品数量（個）')).toHaveValue('1,588');
    await page.getByLabel('欠け').fill('2000');
    await page.getByRole('button', { name: '内容を確認 →' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '不良数の合計が数量を超えています。' })).toBeVisible();
    await page.getByLabel('欠け').fill('4');
    await page.getByRole('button', { name: '内容を確認 →' }).click();

    await expect(page).toHaveURL(/step=5$/);
    await expect(page.getByText('1,600個 / 12個（0.75%）')).toBeVisible();
    await page.getByLabel('内容を確認しました').check();
    await page.getByRole('button', { name: '確定して登録' }).click();
    const done = page.getByRole('status').filter({ hasText: '作業日報を登録しました' });
    await expect(done).toBeVisible();
    await expect(done.locator('b').first()).toHaveText(/^WR-\d{6}-\d{6}$/);
  });

  test('オフライン: バナー表示・下書き継続・確定ボタン無効、復帰で有効（EV-OFFLINE）', async ({ page, context }) => {
    await login(page);
    await page.goto('/field/deliveries/new?step=1');
    await page.getByLabel(/^運転者/).selectOption({ label: 'SYN-W03 合成運転者' });
    await page.getByLabel(/^お客様/).selectOption({ label: 'SYN-C01 合成顧客A' });
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByRole('checkbox', { name: /^SYN-P03/ }).check();
    await page.getByLabel('SYN-P03 の数量').fill('5');
    await context.setOffline(true);
    await expect(page.getByText(/オフラインです。入力は端末に下書き保存されます/)).toBeVisible();
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByLabel('内容を確認しました').check();
    await expect(page.getByRole('button', { name: '確定して登録' })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: '確定して登録' })).toBeEnabled();
    // 後始末: 確定せず下書きのまま残す（ログアウトで削除）
    await page.getByRole('button', { name: 'ログアウト' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page);
    await page.goto('/field');
    await expect(page.getByRole('link', { name: /運搬実績の下書きを再開/ })).toHaveCount(0);
  });
});
