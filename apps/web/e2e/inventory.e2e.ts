import { test, expect, type Page } from '@playwright/test';

/**
 * CHG-018 在庫管理（有り版）ブラウザ E2E。UAT 手順書 S1〜S10 のうち画面で通せるもの。
 * 実行は playwright.inventory.config.ts（メモリ上の DocStore。初期データは /api/e2e-seed）。
 * 開始時の残高: 調整用 185／預かり 1,500（2026-08-31 の検査分）。
 */
const PASSWORD = process.env['E2E_SEED_PASSWORD'] ?? 'E2e-Passw0rd-Inv!';

async function login(page: Page, loginId: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(loginId);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByText(/ようこそ、.+さん/)).toBeVisible();
}

/** 在庫の一覧の MN139931 の行（預かり／調整用／状態）を読む */
async function balanceRow(page: Page): Promise<{ deposit: string; adjust: string; status: string }> {
  await page.goto('/admin/inventory');
  const row = page.getByRole('row', { name: /MN139931/ }).first();
  await expect(row).toBeVisible();
  const cells = row.getByRole('cell');
  return { deposit: ((await cells.nth(2).textContent()) ?? '').trim(), adjust: ((await cells.nth(3).textContent()) ?? '').trim(), status: ((await cells.nth(4).textContent()) ?? '').trim() };
}

interface Report {
  date: string;
  quantity: number;
  defect?: number;
  boxes?: string; // 空なら目安（自動）のまま
  replenish?: number;
  delivered?: { quantity: number; date: string };
  ack?: boolean;
  expect: { deposit: string; adjust: string };
}

/** 現場で作業日報を5 stepで入力し、STEP4 の在庫の見込みを確認して確定する */
async function submitReport(page: Page, r: Report): Promise<void> {
  await login(page, 'e2e-field');
  await page.goto('/field/work-reports/new?step=1');
  await page.getByRole('textbox', { name: /^作業日/ }).fill(r.date);
  await page.getByLabel(/^お客様/).selectOption({ label: 'MARUGO 丸五ゴム工業' });
  await page.getByRole('button', { name: '次へ進む →' }).click();
  await page.getByLabel(/^品番/).selectOption({ label: 'MN139931 パッキン（原紙）' });
  await page.getByLabel(/^作業内容/).selectOption({ label: 'INSP 検査' });
  await page.getByRole('button', { name: '次へ進む →' }).click();
  await page.getByLabel('E2W1 在庫作業者').check();
  await page.getByLabel(/^開始時刻/).fill('09:00');
  await page.getByLabel(/^終了時刻/).fill('12:00');
  await page.getByRole('button', { name: '次へ進む →' }).click();
  await expect(page).toHaveURL(/step=4$/);
  await page.getByLabel(/^処理数量/).fill(String(r.quantity));
  if ((r.defect ?? 0) > 0) await page.getByLabel('破れ').fill(String(r.defect));
  const block = page.locator('.fx-invblock');
  await expect(block).toBeVisible();
  if (r.boxes === undefined) await expect(page.locator('#f-boxCount')).toHaveValue(String(Math.round(r.quantity / 250)));
  else await page.locator('#f-boxCount').fill(r.boxes);
  if (r.replenish !== undefined) await page.locator('#f-replenishBoxes').fill(String(r.replenish));
  if (r.delivered !== undefined) {
    await page.locator('#f-deliveredQuantity').fill(String(r.delivered.quantity));
    await page.locator('#f-deliveredDate').fill(r.delivered.date);
  }
  // 確定前の見込み
  await expect(block).toContainText(`${r.expect.deposit}個`);
  await expect(block).toContainText(`${r.expect.adjust}個`);
  if (r.ack === true) await page.locator('#f-ackAdjust').check();
  await page.getByRole('button', { name: '内容を確認 →' }).click();
  await expect(page).toHaveURL(/step=5$/);
  await expect(page.locator('.fx-confirmcard')).toContainText('在庫');
  await page.getByLabel('内容を確認しました').check();
  await page.getByRole('button', { name: '確定して登録' }).click();
}

test.describe('CHG-018 在庫管理（有り版）', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/e2e-seed');
    expect(res.status()).toBe(200);
  });

  test('0. 事務所: 開始時の残高を登録する（見込みの確認 → 登録）。現場には在庫のメニューが出ない', async ({ page }) => {
    await login(page, 'e2e-office');
    await page.goto('/admin/inventory');
    await expect(page.getByRole('heading', { level: 1, name: '在庫' })).toBeVisible();
    await expect(page.getByText('開始時の残高が未登録')).toBeVisible();
    await page.getByRole('tab', { name: '登録' }).click();
    await page.locator('#inv-date').fill('2026-08-31');
    await page.locator('#inv-adj').fill('185');
    await page.locator('#inv-ld-0').fill('2026-08-31');
    await page.locator('#inv-lq-0').fill('1500');
    await expect(page.getByRole('button', { name: '登録する' })).toBeDisabled(); // 見込みを確認するまで押せない
    await page.getByRole('button', { name: '見込みを確認' }).click();
    await expect(page.locator('.ix-impact')).toContainText('+1,500個');
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByText('登録しました。')).toBeVisible();
    expect(await balanceRow(page)).toMatchObject({ deposit: '1,500', adjust: '185', status: '正常' });
  });

  test('S1. 日報: 数量1,250・不良5・箱数は目安5 → 見込み 預かり2,750／調整用180 → 確定 → 在庫の残高に反映', async ({ page, browser }) => {
    await submitReport(page, { date: '2026-09-01', quantity: 1250, defect: 5, expect: { deposit: '2,750', adjust: '180' } });
    await expect(page.getByRole('status').filter({ hasText: '作業日報を登録しました' })).toBeVisible();
    const office = await browser.newPage();
    await login(office, 'e2e-office');
    expect(await balanceRow(office)).toMatchObject({ deposit: '2,750', adjust: '180' });
    await office.close();
  });

  test('S2. 日報: 納入1,000個・納入日は別の日（9/3） → 預かり3,000／調整用180。古いロット(8/31)から引き当て', async ({ page, browser }) => {
    await submitReport(page, { date: '2026-09-02', quantity: 1250, delivered: { quantity: 1000, date: '2026-09-03' }, expect: { deposit: '3,000', adjust: '180' } });
    await expect(page.getByRole('status').filter({ hasText: '作業日報を登録しました' })).toBeVisible();
    const office = await browser.newPage();
    await login(office, 'e2e-office');
    expect(await balanceRow(office)).toMatchObject({ deposit: '3,000', adjust: '180' });
    await office.getByRole('tab', { name: '残高・ロット' }).click();
    await expect(office.getByRole('row', { name: /2026-08-31/ })).toContainText('500');
    await office.close();
  });

  test('S3. 事務所: 預かり在庫を超える納入は、見込みで不足が出て登録できない', async ({ page }) => {
    await login(page, 'e2e-office');
    await page.goto('/admin/inventory');
    await page.getByRole('tab', { name: '登録' }).click();
    await page.getByText('納入', { exact: true }).click();
    await page.locator('#inv-date').fill('2026-09-04');
    await page.locator('#inv-qty').fill('5000');
    await page.getByRole('button', { name: '見込みを確認' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /預かり.*(足り|不足)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '登録する' })).toBeDisabled();
  });

  test('S4. 日報: 1箱回す → 預かり4,000／調整用430', async ({ page }) => {
    await submitReport(page, { date: '2026-09-05', quantity: 1250, replenish: 1, expect: { deposit: '4,000', adjust: '430' } });
    await expect(page.getByRole('status').filter({ hasText: '作業日報を登録しました' })).toBeVisible();
  });

  test('S5. 日報: 調整用が不足（-170）→ 警告。チェックなしは確定できず、チェックありで記録され問題点に出る', async ({ page, browser }) => {
    await login(page, 'e2e-field');
    await page.goto('/field/work-reports/new?step=1');
    await page.getByRole('textbox', { name: /^作業日/ }).fill('2026-09-06');
    await page.getByLabel(/^お客様/).selectOption({ label: 'MARUGO 丸五ゴム工業' });
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByLabel(/^品番/).selectOption({ label: 'MN139931 パッキン（原紙）' });
    await page.getByLabel(/^作業内容/).selectOption({ label: 'INSP 検査' });
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByLabel('E2W1 在庫作業者').check();
    await page.getByLabel(/^開始時刻/).fill('09:00');
    await page.getByLabel(/^終了時刻/).fill('12:00');
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByLabel(/^処理数量/).fill('1250');
    await page.getByLabel('破れ').fill('600');
    const block = page.locator('.fx-invblock');
    await expect(block).toContainText('-170個');
    await expect(block.getByRole('alert')).toContainText('調整用在庫が足りなくなります');
    await page.getByRole('button', { name: '内容を確認 →' }).click();
    await page.getByLabel('内容を確認しました').check();
    await page.getByRole('button', { name: '確定して登録' }).click();
    await expect(page.getByText(/調整用在庫が -170 個になります/).first()).toBeVisible(); // 確定は拒否される（INVENTORY_ADJUST_SHORT）
    await page.goBack();
    await page.goto('/field/work-reports/new?step=4');
    await page.locator('#f-ackAdjust').check();
    await page.getByRole('button', { name: '内容を確認 →' }).click();
    await page.getByLabel('内容を確認しました').check();
    await page.getByRole('button', { name: '確定して登録' }).click();
    await expect(page.getByRole('status').filter({ hasText: '作業日報を登録しました' })).toBeVisible();
    const office = await browser.newPage();
    await login(office, 'e2e-office');
    const row = await balanceRow(office);
    expect(row).toMatchObject({ deposit: '5,250', adjust: '-170' });
    expect(row.status).toContain('問題点');
    await office.close();
  });

  test('S7. 事務所: 画面で登録した納入を理由付きで取り消す。日報由来の取引には取消しが出ない', async ({ page }) => {
    await login(page, 'e2e-office');
    await page.goto('/admin/inventory');
    await page.getByRole('tab', { name: '登録' }).click();
    await page.getByText('納入', { exact: true }).click();
    await page.locator('#inv-date').fill('2026-09-07');
    await page.locator('#inv-qty').fill('250');
    await page.getByRole('button', { name: '見込みを確認' }).click();
    await page.getByRole('button', { name: '登録する' }).click();
    await expect(page.getByText('登録しました。')).toBeVisible();
    expect((await balanceRow(page)).deposit).toBe('5,000');
    await page.getByRole('tab', { name: '取引の履歴' }).click();
    await expect(page.getByRole('row', { name: /日報/ }).first().getByRole('button', { name: '取り消す' })).toHaveCount(0);
    page.once('dialog', (d) => void d.accept('入力ミス'));
    await page.getByRole('row', { name: /画面/ }).filter({ hasText: '納入' }).first().getByRole('button', { name: '取り消す' }).click();
    await expect(page.getByText(/を取り消しました。/)).toBeVisible();
    expect((await balanceRow(page)).deposit).toBe('5,250');
  });

  test('S8. 事務所: 在庫集計表（画面）と Excel 出力', async ({ page }) => {
    await login(page, 'e2e-office');
    await page.goto('/admin/inventory');
    await page.getByRole('tab', { name: '在庫集計表' }).click();
    await page.locator('#inv-month').fill('2026-09');
    await expect(page.getByRole('table').filter({ hasText: '2026-09-01' })).toBeVisible();
    await expect(page.getByRole('row', { name: /2026-09-01/ })).toContainText('1,250');
    const href = (await page.getByRole('link', { name: 'Excel で出力' }).getAttribute('href')) ?? '';
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('spreadsheetml');
    expect((await res.body()).subarray(0, 2).toString()).toBe('PK');
  });

  test('S9. 事務所: 棚卸は理由が必須。数え直した値で差が記録される', async ({ page }) => {
    await login(page, 'e2e-office');
    await page.goto('/admin/inventory');
    await page.getByRole('tab', { name: '登録' }).click();
    await page.getByText('棚卸', { exact: true }).click();
    await page.locator('#inv-date').fill('2026-09-08');
    await page.locator('#inv-cd').fill('5250');
    await page.locator('#inv-ca').fill('0');
    await page.getByRole('button', { name: '見込みを確認' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /理由/ })).toBeVisible();
  });

  test('S10. 監査: 在庫は見られるが登録・取消しの操作は出ない。現場は在庫の画面に入れない', async ({ page, browser }) => {
    await login(page, 'e2e-auditor');
    await page.goto('/admin/inventory');
    await expect(page.getByRole('heading', { level: 1, name: '在庫' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '登録' })).toHaveCount(0);
    const field = await browser.newPage();
    await login(field, 'e2e-field');
    const res = await field.request.get('/api/v1/inventory');
    expect(res.status()).toBe(403);
    await field.close();
  });
});
