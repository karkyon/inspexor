import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// G4-E2E: 確定 → outbox → worker（常駐）→ 日報PDF → storage → SUBMITTED → Mailpit 受信 → 署名付き URL で取得 → 再送（API-024/025）。
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

test.describe('G4-E2E: 日報PDF・メール（SCR-02 表示、API-024/025）', () => {
  test.beforeAll(() => {
    if (FIELD_PASSWORD === '' || OFFICE_PASSWORD === '') throw new Error('E2E_FIELD_PASSWORD / E2E_OFFICE_PASSWORD が未設定です');
  });

  test('作業日報を確定 → 帳票生成 → 提出済 → メール受信 → PDF 取得 → 事務が再送', async ({ page, browser }) => {
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
        workDate: '2026-10-08',
        reporterId: me.userId,
        customerId: customer?.['id'],
        productId: product?.['id'],
        workTypeId: workType?.['id'],
        lotNo: 'LOT-G4-E2E',
        workerIds: [worker?.['id']],
        startAt: '2026-10-08T00:00:00.000Z',
        endAt: '2026-10-08T01:00:00.000Z',
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
    expect((doc['file'] as { fileName: string }).fileName).toMatch(new RegExp(`^日報_2026-10-08_SYN-C01_${record.reportNo}_r1\\.pdf$`));
    const pdf = await req.get(String(doc['signedUrl']));
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const tampered = await req.get(String(doc['signedUrl']).replace(/sig=./, 'sig=Z'));
    expect(tampered.status()).toBe(403);

    // Mailpit に日報メール（件名に報告番号、PDF 添付）
    await expect.poll(async () => (await mailpitSearch(req, record.reportNo)).length, { timeout: 60_000 }).toBe(1);
    const message = (await mailpitSearch(req, record.reportNo))[0];
    expect(message?.Subject).toBe(`【INSPEXOR作業報告】2026-10-08 SYN-P01 ${record.reportNo}`);
    const full = (await (await req.get(`${MAILPIT}/api/v1/message/${message?.ID}`)).json()) as { Attachments: Array<{ FileName: string }> };
    expect(full.Attachments.map((a) => a.FileName)).toEqual([`日報_2026-10-08_SYN-C01_${record.reportNo}_r1.pdf`]);

    // SCR-02: 最近の登録に「提出済・帳票 作成済」
    await page.goto('/field');
    const row = page.getByRole('listitem').filter({ hasText: record.reportNo });
    await expect(row).toContainText('提出済');
    await expect(row).toContainText('帳票 作成済');

    // 事務（OFFICE）が理由付きで再送（API-025 send）→ 2通目
    const officeContext = await browser.newContext();
    const office = await officeContext.newPage();
    const officeCsrf = await login(office, process.env['E2E_OFFICE_LOGIN_ID'] ?? 'dev-office', OFFICE_PASSWORD);
    const noReason = await office.request.post(`/api/v1/documents/${String(detail['documentId'])}/send`, {
      headers: { 'x-csrf-token': officeCsrf, 'idempotency-key': `e2e-g4-send0-${record.id}` },
      data: { expectedVersion: detail['version'] },
    });
    expect(noReason.status()).toBe(422);
    const resend = await office.request.post(`/api/v1/documents/${String(detail['documentId'])}/send`, {
      headers: { 'x-csrf-token': officeCsrf, 'idempotency-key': `e2e-g4-send1-${record.id}` },
      data: { expectedVersion: detail['version'], reason: 'E2E: 再送確認' },
    });
    expect(resend.status()).toBe(202);
    await expect.poll(async () => (await mailpitSearch(req, record.reportNo)).length, { timeout: 60_000 }).toBe(2);
    // FIELD は documentAction 不可（403）
    const forbidden = await req.post(`/api/v1/documents/${String(detail['documentId'])}/send`, {
      headers: { 'x-csrf-token': csrf, 'idempotency-key': `e2e-g4-send2-${record.id}` },
      data: { expectedVersion: detail['version'], reason: 'x' },
    });
    expect(forbidden.status()).toBe(403);
    await officeContext.close();
  });
});
