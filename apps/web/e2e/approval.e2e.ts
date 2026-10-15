import { login } from './auth';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { TODAY } from './today';

// CHG-007 E2E: 承認ワークフロー（SCR-10/11/12、FR-007/017）。前提: 開発環境で APPROVAL_ENABLED=true、worker 稼働、synthetic seed 投入済み。
//   現場が確定 → 帳票作成（提出済）→ 事務所がダッシュボードで承認待ちを確認 → 差戻し（理由必須）→ 現場が「修正する」で新しい版の下書き
//   → 再確定（新しい版の帳票）→ 事務所が承認 → 承認の取消（理由必須）
const FIELD_PASSWORD = process.env['E2E_FIELD_PASSWORD'] ?? '';
const OFFICE_PASSWORD = process.env['E2E_OFFICE_PASSWORD'] ?? '';


async function masters(request: APIRequestContext, type: string): Promise<Array<Record<string, string>>> {
  const r = await request.get(`/api/v1/masters/${type}?pageSize=100`);
  expect(r.status()).toBe(200);
  return ((await r.json()) as { data: Array<Record<string, string>> }).data;
}

async function detailOf(req: APIRequestContext, id: string): Promise<Record<string, unknown>> {
  return ((await (await req.get(`/api/v1/work-reports/${id}`)).json()) as { data: Record<string, unknown> }).data;
}

async function waitSubmitted(req: APIRequestContext, id: string, revisionNo: number): Promise<void> {
  await expect
    .poll(async () => {
      const d = await detailOf(req, id);
      return `${String(d['status'])}/${String(d['documentStatus'])}/${String(d['revisionNo'])}`;
    }, { timeout: 120_000, intervals: [1000, 2000, 3000] })
    .toBe(`SUBMITTED/GENERATED/${revisionNo}`);
}

test.describe('CHG-007 E2E: 承認ワークフロー', () => {
  test.beforeAll(() => {
    if (FIELD_PASSWORD === '' || OFFICE_PASSWORD === '') throw new Error('E2E_FIELD_PASSWORD / E2E_OFFICE_PASSWORD が未設定です');
  });

  test('提出済 → ダッシュボード → 差戻し → 現場が修正して再確定 → 承認 → 取消', async ({ page, browser }) => {
    test.setTimeout(300_000);
    const csrf = await login(page, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const req = page.request;
    const me = ((await (await req.get('/api/v1/me')).json()) as { data: { userId: string; features: { approval: boolean } } }).data;
    expect(me.features.approval, '開発環境の .env.local に APPROVAL_ENABLED=true が必要です').toBe(true);
    const customer = (await masters(req, 'customers')).find((c) => c['code'] === 'SYN-C01');
    const product = (await masters(req, 'products')).find((p) => p['code'] === 'SYN-P01');
    const workType = (await masters(req, 'work-types')).find((w) => w['productId'] === product?.['id'] && w['active']);
    const worker = (await masters(req, 'workers')).find((w) => w['code'] === 'SYN-W01');
    const created = await req.post('/api/v1/work-reports', {
      headers: { 'x-csrf-token': csrf },
      data: {
        workDate: TODAY, reporterId: me.userId, customerId: customer?.['id'], productId: product?.['id'], workTypeId: workType?.['id'], lotNo: 'LOT-APR-E2E',
        workerIds: [worker?.['id']], startAt: `${TODAY}T00:00:00.000Z`, endAt: `${TODAY}T01:00:00.000Z`, quantity: 50, defects: [],
      },
    });
    expect(created.status()).toBe(201);
    const record = ((await created.json()) as { data: { id: string; reportNo: string } }).data;
    expect((await req.post(`/api/v1/work-reports/${record.id}/confirm`, { headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-apr-c1-${record.id}` }, data: { expectedVersion: 1 } })).status()).toBe(202);
    await waitSubmitted(req, record.id, 1);

    // 事務所: ダッシュボードの承認待ち → 詳細で差戻し（理由なしはエラー）
    const office = await (await browser.newContext()).newPage();
    await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    await office.goto('/admin/dashboard');
    await expect(office.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    await expect(office.getByRole('region', { name: '主要指標' })).toContainText('承認待ち');
    await office.goto(`/admin/records/work/${record.id}`);
    await expect(office.getByRole('heading', { name: '承認', exact: true })).toBeVisible();
    await office.getByRole('button', { name: '↩ 差し戻す' }).click();
    await expect(office.locator('.ix-approval [role="alert"]')).toContainText('差戻し理由を入力してください');
    await office.getByLabel(/コメント/).fill('数量を再確認してください（E2E）');
    await office.getByRole('button', { name: '↩ 差し戻す' }).click();
    await expect(office.locator('.ix-pagehead .ix-pill')).toHaveText('差戻し');
    await expect(office.locator('.ix-decision')).toContainText('数量を再確認してください（E2E）');

    // 現場: 最近の登録に差戻し理由 → 修正する → 新しい版の下書きを入力画面に読み込む
    await page.goto('/field');
    const row = page.getByRole('listitem').filter({ hasText: record.reportNo });
    await expect(row).toContainText('差戻し');
    await expect(row).toContainText('数量を再確認してください（E2E）');
    await row.getByRole('button', { name: '修正する' }).click();
    await row.getByLabel('修正内容').fill('数量を訂正');
    await row.getByRole('button', { name: '入力画面で直す' }).click();
    await expect(page).toHaveURL(/\/field\/work-reports\/new\?step=1$/);
    const draft = await detailOf(req, record.id);
    expect(draft).toMatchObject({ status: 'DRAFT', revisionNo: 2 });
    // 入力画面の操作は G3 E2E で検証済み。ここでは API で数量を直して確定する
    const body = Object.fromEntries(
      ['workDate', 'reporterId', 'customerId', 'productId', 'workTypeId', 'lotNo', 'workerIds', 'startAt', 'endAt', 'defects', 'workLocationId', 'vehicleId', 'remarks'].map((k) => [k, draft[k]]),
    );
    const patched = await req.patch(`/api/v1/work-reports/${record.id}`, { headers: { 'x-csrf-token': csrf }, data: { ...body, quantity: 48, expectedVersion: draft['version'] } });
    expect(patched.status()).toBe(200);
    const v = ((await patched.json()) as { data: { version: number } }).data.version;
    expect((await req.post(`/api/v1/work-reports/${record.id}/confirm`, { headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-apr-c2-${record.id}` }, data: { expectedVersion: v } })).status()).toBe(202);
    await waitSubmitted(req, record.id, 2);
    await page.evaluate(() => window.localStorage.clear());

    // 事務所: 承認 → 取消（理由必須）
    await office.reload();
    await expect(office.getByRole('heading', { name: '承認', exact: true })).toBeVisible();
    await office.getByRole('button', { name: '✓ 承認する' }).click();
    await expect(office.locator('.ix-pagehead .ix-pill')).toHaveText('承認済');
    await expect(office.getByRole('heading', { name: '承認の取消' })).toBeVisible();
    await office.getByRole('button', { name: '承認を取り消す' }).click();
    await expect(office.locator('.ix-approval [role="alert"]')).toContainText('取消理由を入力してください');
    await office.getByLabel(/取消理由/).fill('E2E 取消');
    await office.getByRole('button', { name: '承認を取り消す' }).click();
    await expect(office.locator('.ix-pagehead .ix-pill')).toHaveText('取消');
  });
});
