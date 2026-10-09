import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { TODAY } from './today';

// G4-E2E（CHG-004 で更新）: 確定 → outbox → worker（常駐）→ 日報PDF → storage → SUBMITTED → 署名付き URL で取得
// → メールは送らない（提案書: 自動送信は対象外）→ 現場ホームから PDF 表示 → 事務所が PDF 再出力（API-024/025）。
// 前提: dev サーバー・worker（pnpm --filter @inspexor/worker dev）・Mailpit（docker compose up -d mailpit）が起動中、synthetic seed 投入済み。
const FIELD_PASSWORD = process.env['E2E_FIELD_PASSWORD'] ?? '';
const OFFICE_PASSWORD = process.env['E2E_OFFICE_PASSWORD'] ?? '';
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

async function login(page: Page, loginId: string, password: string): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(loginId);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).toHaveURL(/\/$/);
  return (await page.evaluate(() => window.sessionStorage.getItem('inspexor_csrf_token'))) ?? '';
}

async function masters(request: APIRequestContext, type: string): Promise<Array<Record<string, string>>> {
  const r = await request.get(`/api/v1/masters/${type}?pageSize=100`);
  expect(r.status()).toBe(200);
  return ((await r.json()) as { data: Array<Record<string, string>> }).data;
}

async function mailpitSearch(request: APIRequestContext, reportNo: string): Promise<Array<{ ID: string; Subject: string }>> {
  const r = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${reportNo}"`)}`);
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { messages: Array<{ ID: string; Subject: string }> }).messages;
}

test.describe('G4-E2E: 日報PDF（CHG-004: メールなし、SCR-02 表示、API-024/025）', () => {
  test.beforeAll(() => {
    if (FIELD_PASSWORD === '' || OFFICE_PASSWORD === '') throw new Error('E2E_FIELD_PASSWORD / E2E_OFFICE_PASSWORD が未設定です');
  });

  test('作業日報を確定 → 帳票生成 → 提出済 → メール送信なし → PDF 表示 → 事務所が PDF 再出力', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const csrf = await login(page, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const req = page.request;
    const me = ((await (await req.get('/api/v1/me')).json()) as { data: { userId: string } }).data;
    const customer = (await masters(req, 'customers')).find((c) => c['code'] === 'SYN-C01');
    const product = (await masters(req, 'products')).find((p) => p['code'] === 'SYN-P01');
    const workType = (await masters(req, 'work-types')).find((w) => w['productId'] === product?.['id'] && w['active']);
    const worker = (await masters(req, 'workers')).find((w) => w['code'] === 'SYN-W01');
    expect(customer && product && workType && worker).toBeTruthy();

    const created = await req.post('/api/v1/work-reports', {
      headers: { 'x-csrf-token': csrf },
      data: {
        workDate: TODAY,
        reporterId: me.userId,
        customerId: customer?.['id'],
        productId: product?.['id'],
        workTypeId: workType?.['id'],
        lotNo: 'LOT-G4-E2E',
        workerIds: [worker?.['id']],
        startAt: `${TODAY}T00:00:00.000Z`,
        endAt: `${TODAY}T01:00:00.000Z`,
        quantity: 100,
        defects: [],
      },
    });
    expect(created.status()).toBe(201);
    const record = ((await created.json()) as { data: { id: string; reportNo: string } }).data;
    const confirmed = await req.post(`/api/v1/work-reports/${record.id}/confirm`, {
      headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-g4-${record.id}` },
      data: { expectedVersion: 1 },
    });
    expect(confirmed.status()).toBe(202);

    // worker が処理するまで待つ（REQ-DOC-001: 60秒内 queue・5分内生成。開発環境では数秒）
    let detail: Record<string, unknown> = {};
    await expect
      .poll(
        async () => {
          detail = ((await (await req.get(`/api/v1/work-reports/${record.id}`)).json()) as { data: Record<string, unknown> }).data;
          return `${String(detail['status'])}/${String(detail['documentStatus'])}`;
        },
        { timeout: 120_000, intervals: [1000, 2000, 3000] },
      )
      .toBe('SUBMITTED/GENERATED');

    // API-024: メタデータと10分の署名付き URL
    const doc = ((await (await req.get(`/api/v1/documents/${String(detail['documentId'])}`)).json()) as { data: Record<string, unknown> }).data;
    expect((doc['file'] as { fileName: string }).fileName).toMatch(new RegExp(`^日報_${TODAY}_SYN-C01_${record.reportNo}_r1\\.pdf$`));
    const pdf = await req.get(String(doc['signedUrl']));
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const tampered = await req.get(String(doc['signedUrl']).replace(/sig=./, 'sig=Z'));
    expect(tampered.status()).toBe(403);

    // CHG-004: 日報メールは送らない（worker は mail job を作らない）
    await page.waitForTimeout(5000);
    expect(await mailpitSearch(req, record.reportNo)).toHaveLength(0);
    expect(((await (await req.get(`/api/v1/documents/${String(detail['documentId'])}`)).json()) as { data: { mails: unknown[] } }).data.mails).toEqual([]);

    // SCR-02: 最近の登録に「提出済・帳票 作成済」と PDF 表示
    await page.goto('/field');
    const row = page.getByRole('listitem').filter({ hasText: record.reportNo });
    await expect(row).toContainText('提出済');
    await expect(row).toContainText('帳票 作成済');
    await row.getByRole('button', { name: '日報PDFを表示' }).click();
    const preview = row.getByRole('link', { name: '日報PDFをプレビュー' });
    await expect(preview).toBeVisible();
    expect((await page.request.get((await preview.getAttribute('href')) ?? '')).headers()['content-type']).toBe('application/pdf');

    // 事務所（OFFICE）: send は未定義の操作（404）、理由付き PDF 再出力（regenerate）は 202
    const officeContext = await browser.newContext();
    const office = await officeContext.newPage();
    const officeCsrf = await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    const send = await office.request.post(`/api/v1/documents/${String(detail['documentId'])}/send`, {
      headers: { 'x-csrf-token': officeCsrf, 'idempotency-key': `e2e-g4-send-${record.id}` },
      data: { expectedVersion: detail['version'], reason: 'E2E: 送信' },
    });
    expect(send.status()).toBe(404);
    const noReason = await office.request.post(`/api/v1/documents/${String(detail['documentId'])}/regenerate`, {
      headers: { 'x-csrf-token': officeCsrf, 'idempotency-key': `e2e-g4-regen0-${record.id}` },
      data: { expectedVersion: detail['version'] },
    });
    expect(noReason.status()).toBe(422);
    const regen = await office.request.post(`/api/v1/documents/${String(detail['documentId'])}/regenerate`, {
      headers: { 'x-csrf-token': officeCsrf, 'idempotency-key': `e2e-g4-regen1-${record.id}` },
      data: { expectedVersion: detail['version'], reason: 'E2E: PDF再出力' },
    });
    expect(regen.status()).toBe(202);
    await expect
      .poll(async () => ((await (await req.get(`/api/v1/work-reports/${record.id}`)).json()) as { data: { documentId: string } }).data.documentId, { timeout: 60_000 })
      .not.toBe(detail['documentId']);
    await expect.poll(async () => ((await (await req.get(`/api/v1/work-reports/${record.id}`)).json()) as { data: { documentStatus: string } }).data.documentStatus, { timeout: 60_000 }).toBe('GENERATED');
    expect(await mailpitSearch(req, record.reportNo)).toHaveLength(0);
    // FIELD は documentAction 不可（403）
    const forbidden = await req.post(`/api/v1/documents/${String(detail['documentId'])}/regenerate`, {
      headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-g4-regen2-${record.id}` },
      data: { expectedVersion: detail['version'], reason: 'x' },
    });
    expect(forbidden.status()).toBe(403);
    await officeContext.close();
  });
});
