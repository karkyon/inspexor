import { test, expect, type Page } from '@playwright/test';
import { MONTH, TODAY } from './today';

// CHG-004 D4 E2E: 月次集計（提案書 P.10）→ 表の切替 → Excel / CSV 出力。前提: dev-office、synthetic seed と確定済み報告（他の E2E で作成）。
const OFFICE_PASSWORD = process.env['E2E_OFFICE_PASSWORD'] ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office');
  await page.getByLabel('パスワード').fill(OFFICE_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('CHG-004 E2E: 月次集計・Excel/CSV', () => {
  test.beforeAll(() => {
    if (OFFICE_PASSWORD === '') throw new Error('E2E_OFFICE_PASSWORD が未設定です');
  });

  test('今月を集計 → KPI・日別/品番別/作業内容別/明細 → Excel・CSV をダウンロード', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: '月次集計へ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '月次集計' })).toBeVisible();
    await page.getByLabel('対象年月').fill(MONTH);
    await page.getByLabel('お客様').selectOption({ label: 'SYN-C01 合成顧客A' });
    await page.getByRole('button', { name: '集計する' }).click();
    await expect(page).toHaveURL(new RegExp(`month=${MONTH}`));
    const kpis = page.getByRole('region', { name: `${MONTH} の集計` });
    await expect(kpis).toContainText('総作業個数');
    await expect(kpis).toContainText('手入力運搬費');

    // API と画面の合計が一致
    const api = (await (await page.request.get(`/api/v1/reports/monthly?${new URL(page.url()).searchParams.toString()}`)).json()) as { data: { totals: { workQuantity: number; tripCount: number } } };
    expect(api.data.totals.workQuantity).toBeGreaterThan(0);
    await expect(kpis).toContainText(api.data.totals.workQuantity.toLocaleString('ja-JP'));
    await expect(kpis).toContainText(`${api.data.totals.tripCount.toLocaleString('ja-JP')}回`);

    await expect(page.getByRole('cell', { name: TODAY, exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: '品番別' }).click();
    await expect(page.getByRole('cell', { name: 'SYN-P01', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '作業内容別' }).click();
    await expect(page.getByRole('cell', { name: '検査', exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: '明細' }).click();
    await expect(page.getByRole('link', { name: new RegExp(`^WR-${MONTH.replace('-', '')}-`) }).first()).toBeVisible();

    // Excel（ダウンロード）
    const xlsxHref = (await page.getByRole('link', { name: 'Excel で出力（全シート）' }).getAttribute('href')) ?? '';
    const xlsx = await page.request.get(xlsxHref);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()['content-disposition']).toContain(encodeURIComponent(`月次集計_${MONTH}.xlsx`));
    expect([...(await xlsx.body()).subarray(0, 2)]).toEqual([0x50, 0x4b]); // ZIP（xlsx）
    // CSV（表示中の表＝明細）
    const csvHref = (await page.getByRole('link', { name: 'CSV で出力（明細）' }).getAttribute('href')) ?? '';
    const csv = await page.request.get(csvHref);
    expect(csv.status()).toBe(200);
    const body = await csv.body();
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.toString('utf8')).toContain('日付,種別,報告番号,版,お客様,品番,作業内容,数量');
  });
});
