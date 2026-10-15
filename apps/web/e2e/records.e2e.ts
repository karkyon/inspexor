import { login } from './auth';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { TODAY } from './today';

// CHG-004 batch16 E2E: 事務所の報告一覧（絞込）→ 詳細 → 運搬費の後入力 → 確定後修正（新しい版）→ 再確定 → PDF 再出力。
// 前提: dev サーバー・worker 起動中、synthetic seed（車両・作業場所を含む）投入済み、dev-field / dev-office。
const FIELD_PASSWORD = process.env['E2E_FIELD_PASSWORD'] ?? '';
const OFFICE_PASSWORD = process.env['E2E_OFFICE_PASSWORD'] ?? '';


async function masters(request: APIRequestContext, type: string): Promise<Array<Record<string, string>>> {
  return ((await (await request.get(`/api/v1/masters/${type}?pageSize=100`)).json()) as { data: Array<Record<string, string>> }).data;
}

async function createConfirmedDelivery(page: Page, csrf: string): Promise<{ id: string; reportNo: string }> {
  const req = page.request;
  const customer = (await masters(req, 'customers')).find((c) => c['code'] === 'SYN-C01');
  const products = await masters(req, 'products');
  const driver = (await masters(req, 'workers')).find((w) => w['code'] === 'SYN-W03');
  const created = await req.post('/api/v1/delivery-reports', {
    headers: { 'x-csrf-token': csrf },
    data: {
      deliveryDate: TODAY,
      driverId: driver?.['id'],
      customerId: customer?.['id'],
      items: [
        { productId: products.find((p) => p['code'] === 'SYN-P03')?.['id'], quantity: 300 },
        { productId: products.find((p) => p['code'] === 'SYN-P04')?.['id'], quantity: 200 },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const rec = ((await created.json()) as { data: { id: string; reportNo: string } }).data;
  const confirmed = await req.post(`/api/v1/delivery-reports/${rec.id}/confirm`, {
    headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-b16-d-${rec.id}` },
    data: { expectedVersion: 1 },
  });
  expect(confirmed.status()).toBe(202);
  return rec;
}

test.describe('CHG-004 E2E: 事務所の報告一覧・詳細・運搬費・確定後修正', () => {
  test.beforeAll(() => {
    if (FIELD_PASSWORD === '' || OFFICE_PASSWORD === '') throw new Error('E2E_FIELD_PASSWORD / E2E_OFFICE_PASSWORD が未設定です');
  });

  test('運搬: 一覧で絞込 → 詳細 → 運搬費を後入力 → 修正（版2）で運搬回数を直して確定 → 版2の帳票', async ({ browser }) => {
    test.setTimeout(240_000);
    const fieldCtx = await browser.newContext();
    const field = await fieldCtx.newPage();
    const fieldCsrf = await login(field, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const rec = await createConfirmedDelivery(field, fieldCsrf);
    await fieldCtx.close();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    await page.getByRole('link', { name: '報告一覧へ（事務所）' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '報告一覧' })).toBeVisible();

    // 絞込: 期間・種別・品番
    await page.getByLabel('期間（から）').fill(TODAY);
    await page.getByLabel('期間（まで）').fill(TODAY);
    await page.getByLabel('種別').selectOption({ label: '運搬実績' });
    await page.getByLabel('お客様').selectOption({ label: 'SYN-C01 合成顧客A' });
    await page.getByLabel('品番').selectOption({ label: 'SYN-P04 合成品番04（運搬対象）' });
    await page.getByRole('button', { name: '絞り込む' }).click();
    await expect(page).toHaveURL(/type=DELIVERY/);
    const row = page.getByRole('row').filter({ hasText: rec.reportNo });
    await expect(row).toContainText('SYN-P03 合成品番03（運搬対象） ほか1品番');
    await expect(row).toContainText('500個');
    await expect(row).toContainText('未確定');
    await expect(page.getByRole('row').filter({ hasText: '作業日報' })).toHaveCount(0);

    // 詳細 → 運搬費
    await row.getByRole('link', { name: rec.reportNo }).click();
    await expect(page.getByRole('heading', { level: 1, name: `運搬実績 ${rec.reportNo}` })).toBeVisible();
    await page.getByLabel('運搬費（円）').fill('abc');
    await page.getByRole('button', { name: '運搬費を保存' }).click();
    await expect(page.getByRole('status').filter({ hasText: '0〜9,999,999円' })).toBeVisible();
    await page.getByLabel('運搬費（円）').fill('2,500');
    await page.getByRole('button', { name: '運搬費を保存' }).click();
    await expect(page.locator('.ix-dl')).toContainText('2,500円');

    // 確定後修正: 理由必須 → 新しい版の下書き → 入力画面
    await page.getByRole('button', { name: '修正を始める' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '修正理由を入力してください。' })).toBeVisible();
    await page.getByLabel(/^修正理由/).fill('E2E: 運搬回数の訂正');
    await page.getByRole('button', { name: '修正を始める' }).click();
    await expect(page).toHaveURL(/\/field\/deliveries\/new\?step=1$/);
    await expect(page.getByText(`運搬実績を登録（${rec.reportNo}）`)).toBeVisible();
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await expect(page.getByLabel('SYN-P03 の数量')).toHaveValue('300');
    await expect(page.getByLabel(/^運搬費/)).toHaveValue('2500');
    await page.getByLabel(/^運搬回数/).fill('2');
    await page.getByRole('button', { name: '次へ進む →' }).click();
    await page.getByLabel('内容を確認しました').check();
    await page.getByRole('button', { name: '確定して登録' }).click();
    await expect(page.getByRole('status').filter({ hasText: '運搬実績を登録しました' })).toBeVisible();
    await page.getByRole('link', { name: '事務所の詳細画面へ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `運搬実績 ${rec.reportNo}` })).toBeVisible();
    await expect(page.locator('.ix-pagehead')).toContainText('版2');
    await expect(page.locator('.ix-dl')).toContainText('2回');
    await expect(page.locator('.ix-dl')).toContainText('2,500円');
    // worker が版2の帳票を作ると「作成済」とプレビューが出る
    await expect
      .poll(async () => {
        await page.reload();
        return expect(page.getByRole('link', { name: '運搬報告PDFをプレビュー' })).toBeVisible({ timeout: 5000 }).then(() => 1, () => 0);
      }, { timeout: 90_000, intervals: [2000, 3000, 5000] })
      .toBe(1);
    await ctx.close();
  });

  test('作業: 詳細で備考・不具合なし・日報PDFを表示し、理由付きで再出力', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const csrf = await login(page, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const req = page.request;
    const me = ((await (await req.get('/api/v1/me')).json()) as { data: { userId: string } }).data;
    const customer = (await masters(req, 'customers')).find((c) => c['code'] === 'SYN-C01');
    const product = (await masters(req, 'products')).find((p) => p['code'] === 'SYN-P01');
    const workType = (await masters(req, 'work-types')).find((w) => w['productId'] === product?.['id']);
    const worker = (await masters(req, 'workers')).find((w) => w['code'] === 'SYN-W01');
    const created = await req.post('/api/v1/work-reports', {
      headers: { 'x-csrf-token': csrf },
      data: {
        workDate: TODAY, reporterId: me.userId, customerId: customer?.['id'], productId: product?.['id'], workTypeId: workType?.['id'],
        lotNo: null, workerIds: [worker?.['id']], startAt: `${TODAY}T00:00:00.000Z`, endAt: `${TODAY}T01:00:00.000Z`, quantity: 50, defects: [],
        remarks: 'E2E 備考',
      },
    });
    const rec = ((await created.json()) as { data: { id: string; reportNo: string } }).data;
    await req.post(`/api/v1/work-reports/${rec.id}/confirm`, { headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-b16-w-${rec.id}` }, data: { expectedVersion: 1 } });
    await ctx.close();

    const officeCtx = await browser.newContext();
    const office = await officeCtx.newPage();
    await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    await office.goto(`/admin/records/work/${rec.id}`);
    await expect(office.getByRole('heading', { level: 1, name: `作業日報 ${rec.reportNo}` })).toBeVisible();
    await expect(office.locator('.ix-dl')).toContainText('E2E 備考');
    await expect(office.locator('.ix-dl')).toContainText('不具合なし');
    await expect
      .poll(async () => {
        await office.reload();
        return expect(office.getByRole('link', { name: '日報PDFをプレビュー' })).toBeVisible({ timeout: 5000 }).then(() => 1, () => 0);
      }, { timeout: 90_000, intervals: [2000, 3000, 5000] })
      .toBe(1);
    const href = (await office.getByRole('link', { name: '日報PDFをプレビュー' }).getAttribute('href')) ?? '';
    expect((await office.request.get(href)).headers()['content-type']).toBe('application/pdf');
    await office.getByRole('button', { name: '日報PDFを再出力' }).click();
    await expect(office.getByRole('status').filter({ hasText: '再出力の理由を入力してください。' })).toBeVisible();
    await office.getByLabel('再出力の理由').fill('E2E: 再出力');
    await office.getByRole('button', { name: '日報PDFを再出力' }).click();
    await expect(office.getByRole('status').filter({ hasText: '再出力を受け付けました' })).toBeVisible();
    await officeCtx.close();
  });

  test('CHG-012 代理入力: 事務所が現場の方を報告者に選ぶと理由が必須 → 確定 → 本人の報告になり、詳細に代理入力が出る', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext();
    const office = await ctx.newPage();
    const csrf = await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    const req = office.request;
    const users = ((await (await req.get('/api/v1/users')).json()) as { data: Array<{ id: string; loginId: string; displayName: string }> }).data;
    const fieldUser = users.find((u) => u.loginId === (process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field'));
    expect(fieldUser).toBeDefined();

    // 画面: 報告者に現場の方を選ぶと「代理入力の理由」が必須になる
    await office.goto('/field/work-reports/new');
    await office.getByLabel('報告者').selectOption({ label: `${fieldUser?.displayName}（${fieldUser?.loginId}）の代理で入力` });
    await expect(office.getByLabel(/^代理入力の理由/)).toBeVisible();
    await office.getByRole('button', { name: /次へ/ }).first().click();
    await expect(office.getByText('代理入力の理由を入力してください。').first()).toBeVisible();
    await office.getByLabel('報告者').selectOption({ index: 0 });
    await expect(office.getByLabel(/^代理入力の理由/)).toHaveCount(0);

    // API: 代理で作成 → 確定（ログイン直後なので本人確認は不要）
    const customer = (await masters(req, 'customers')).find((c) => c['code'] === 'SYN-C01');
    const product = (await masters(req, 'products')).find((p) => p['code'] === 'SYN-P01');
    const workType = (await masters(req, 'work-types')).find((w) => w['productId'] === product?.['id']);
    const worker = (await masters(req, 'workers')).find((w) => w['code'] === 'SYN-W01');
    const body = {
      workDate: TODAY, reporterId: fieldUser?.id, customerId: customer?.['id'], productId: product?.['id'], workTypeId: workType?.['id'],
      lotNo: null, workerIds: [worker?.['id']], startAt: `${TODAY}T00:00:00.000Z`, endAt: `${TODAY}T01:00:00.000Z`, quantity: 20, defects: [],
    };
    expect((await req.post('/api/v1/work-reports', { headers: { 'x-csrf-token': csrf }, data: body })).status()).toBe(422);
    const created = await req.post('/api/v1/work-reports', { headers: { 'x-csrf-token': csrf }, data: { ...body, proxyReason: 'E2E: 現場の端末故障' } });
    expect(created.status()).toBe(201);
    const rec = ((await created.json()) as { data: { id: string; reportNo: string } }).data;
    expect((await req.post(`/api/v1/work-reports/${rec.id}/confirm`, { headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-proxy-${rec.id}` }, data: { expectedVersion: 1 } })).status()).toBe(202);
    await office.goto(`/admin/records/work/${rec.id}`);
    const note = office.getByRole('note', { name: '代理入力' });
    await expect(note).toContainText('E2E: 現場の端末故障');
    await ctx.close();

    // 報告者本人（現場）の報告として見える
    const fctx = await browser.newContext();
    const field = await fctx.newPage();
    await login(field, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const d = ((await (await field.request.get(`/api/v1/work-reports/${rec.id}`)).json()) as { data: { reporterId: string; proxy: { reason: string } | null } }).data;
    expect(d.reporterId).toBe(fieldUser?.id);
    expect(d.proxy?.reason).toBe('E2E: 現場の端末故障');
    await fctx.close();
  });
});
