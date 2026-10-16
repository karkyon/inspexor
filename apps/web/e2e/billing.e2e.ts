import { login } from './auth';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { MONTH, TODAY } from './today';

// CHG-009 E2E: 請求計算・レビュー・確定（SCR-14、FR-009〜014）。前提: 開発環境で APPROVAL_ENABLED=true・BILLING_ENABLED=true、worker 稼働、synthetic seed 投入済み。
//   管理者が E2E 専用のお客様（実行ごとに一意）・品番・単価/固定費ルールを作る → 現場が2件確定（1件は単価ルールなし）→ 提出済 → 承認
//   → 請求画面でお客様・今月を選んで計算 → 要確認（単価なし）を「除外」でレビュー → 確定 → 請求書番号・報告が請求確定済
// CHG-011: → 請求書画面で発行（鏡・明細の PDF）→ 送付（Mailpit に添付2件）→ 遅延訂正の調整を登録・取消 → 無効化（報告は承認済みに戻る）
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const ADMIN_PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const FIELD_PASSWORD = process.env['E2E_FIELD_PASSWORD'] ?? '';


async function post(req: APIRequestContext, csrf: string, path: string, data: unknown, key?: string): Promise<Record<string, unknown>> {
  const res = await req.post(`/api/v1${path}`, { headers: { 'x-csrf-token': csrf, ...(key !== undefined ? { 'idempotency-key': key } : {}) }, data });
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  expect(res.status(), `${path} ${JSON.stringify(body)}`).toBeLessThan(300);
  return body.data ?? {};
}

async function detailOf(req: APIRequestContext, id: string): Promise<Record<string, unknown>> {
  return ((await (await req.get(`/api/v1/work-reports/${id}`)).json()) as { data: Record<string, unknown> }).data;
}

test.describe('CHG-009 E2E: 請求', () => {
  test.beforeAll(() => {
    if (ADMIN_PASSWORD === '' || FIELD_PASSWORD === '') throw new Error('E2E_PASSWORD / E2E_FIELD_PASSWORD が未設定です');
  });

  test('ルール作成 → 承認済みの報告で計算 → 要確認を除外してレビュー → 確定 → 請求書の発行・送付・調整・無効化', async ({ page, browser }) => {
    test.setTimeout(480_000);
    const adminCsrf = await login(page, process.env['E2E_LOGIN_ID'] ?? 'dev-admin', ADMIN_PASSWORD);
    const admin = page.request;
    const me = ((await (await admin.get('/api/v1/me')).json()) as { data: { features: { billing: boolean } } }).data;
    test.skip(!me.features.billing, '請求機能（BILLING_ENABLED）が無効の環境ではスキップ');

    // ---- 管理者: E2E 専用のお客様・品番・作業内容・単価ルール・固定費（実行ごとに一意）
    const code = `E2EB${Date.now().toString(36).toUpperCase()}`;
    const customer = await post(admin, adminCsrf, '/masters/customers', { code, name: 'E2E請求先', closingDay: 31 });
    const p1 = await post(admin, adminCsrf, '/masters/products', { customerId: customer['id'], code: `${code}-1`, name: '請求品1', settlementType: 'QUANTITY' });
    const p2 = await post(admin, adminCsrf, '/masters/products', { customerId: customer['id'], code: `${code}-2`, name: '単価なし品', settlementType: 'QUANTITY' });
    const wt1 = await post(admin, adminCsrf, '/masters/work-types', { productId: p1['id'], code: 'INSP', name: '検査' });
    const wt2 = await post(admin, adminCsrf, '/masters/work-types', { productId: p2['id'], code: 'INSP', name: '検査' });
    await post(admin, adminCsrf, '/masters/rates', { productId: p1['id'], unitPrice: '4.4', validFrom: '2026-01-01' });
    await post(admin, adminCsrf, '/masters/fixed-charges', { productId: p1['id'], label: '保管料', amountYen: 1000, validFrom: '2026-01-01' });
    await post(admin, adminCsrf, '/masters/contacts', { customerId: customer['id'], code: 'KEIRI', name: '経理', email: `e2e-inv-${code.toLowerCase()}@example.com`, sendInvoice: true });

    // ---- 現場: 2件を確定（帳票作成で提出済になるまで待つ）
    const fieldPage = await (await browser.newContext()).newPage();
    const fieldCsrf = await login(fieldPage, process.env['E2E_FIELD_LOGIN_ID'] ?? 'dev-field', FIELD_PASSWORD);
    const field = fieldPage.request;
    const fieldMe = ((await (await field.get('/api/v1/me')).json()) as { data: { userId: string } }).data;
    const worker = ((await (await field.get('/api/v1/masters/workers?pageSize=100')).json()) as { data: Array<Record<string, string>> }).data.find((w) => w['code'] === 'SYN-W01');
    const ids: string[] = [];
    for (const [product, workType, quantity] of [[p1, wt1, 1600], [p2, wt2, 5]] as const) {
      const created = await post(field, fieldCsrf, '/work-reports', {
        workDate: TODAY, reporterId: fieldMe.userId, customerId: customer['id'], productId: product['id'], workTypeId: workType['id'], lotNo: null,
        workerIds: [worker?.['id']], startAt: `${TODAY}T00:00:00.000Z`, endAt: `${TODAY}T01:00:00.000Z`, quantity, defects: [],
      });
      const id = created['id'] as string;
      await post(field, fieldCsrf, `/work-reports/${id}/confirm`, { expectedVersion: 1 }, `e2e-bil-c-${id}`);
      ids.push(id);
    }
    for (const id of ids) {
      await expect.poll(async () => String((await detailOf(admin, id))['status']), { timeout: 120_000, intervals: [1000, 2000, 3000] }).toBe('SUBMITTED');
      const d = await detailOf(admin, id);
      await post(admin, adminCsrf, `/records/WORK/${id}/approve`, { expectedVersion: d['version'] }, `e2e-bil-a-${id}`);
    }

    // ---- 請求: お客様・今月を選んで計算
    await page.goto('/admin/billing');
    await expect(page.getByRole('heading', { level: 1, name: '請求' })).toBeVisible();
    await page.getByRole('button', { name: '請求を計算する' }).click();
    await expect(page.locator('.ix-errorsummary')).toContainText('お客様を選んでください');
    await page.getByLabel(/^お客様/).selectOption({ label: `${code} E2E請求先（月末締め）` });
    await page.getByLabel(/^請求月/).fill(MONTH);
    await page.getByRole('button', { name: '請求を計算する' }).click();
    await expect(page).toHaveURL(/\/admin\/billing\/[0-9a-f-]{36}$/, { timeout: 30_000 }); // 開発サーバーは初回表示時に画面を組み立てるため長めに待つ（g34 の初回失敗）
    await expect(page.getByRole('heading', { level: 1, name: /請求計算・レビュー/ })).toBeVisible();
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('要確認');
    const totals = page.getByRole('region', { name: '請求の合計' });
    await expect(totals).toContainText('¥8,040'); // 1,600個×4.4円 + 保管料 1,000円
    await expect(totals).toContainText('¥804');
    await expect(totals).toContainText('¥8,844');
    await expect(page.getByRole('region', { name: '請求明細' })).toContainText('固定費');

    // 確定は警告の処置（レビュー）が終わるまで出ない
    await expect(page.getByRole('button', { name: '請求を確定' })).toHaveCount(0);
    await page.getByRole('combobox', { name: /の処置$/ }).selectOption('EXCLUDE');
    await expect(page.getByRole('button', { name: 'レビューを完了' })).toBeDisabled();
    await page.getByLabel(/^レビューの理由/).fill('単価未設定の品番は今回は請求しない（E2E）');
    await page.getByRole('button', { name: 'レビューを完了' }).click();
    await expect(page.getByRole('status')).toContainText('レビューを完了しました');
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('確認済み');

    // 確定 → 請求書番号、報告は請求確定済（除外した報告は承認済のまま）
    await page.getByRole('button', { name: '請求を確定' }).click();
    await expect(page.getByRole('status')).toContainText('請求を確定しました');
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('確定済み');
    await expect(page.locator('.ix-decision')).toContainText(`INV-${MONTH.replace('-', '')}-${code}`);
    expect((await detailOf(admin, ids[0] as string))['status']).toBe('BILLING_LOCKED');
    expect((await detailOf(admin, ids[1] as string))['status']).toBe('APPROVED');

    // 一覧に確定済みとして出る
    await page.goto('/admin/billing');
    const row = page.getByRole('row').filter({ hasText: code });
    await expect(row).toContainText('確定済み');
    await expect(row).toContainText('¥8,844');

    // ---- CHG-011 請求書: 一覧の請求書番号から請求書画面へ
    const invoiceNo = `INV-${MONTH.replace('-', '')}-${code}-001`;
    await row.getByRole('link', { name: invoiceNo }).click();
    await expect(page).toHaveURL(/\/admin\/invoices\/[0-9a-f-]{36}$/, { timeout: 30_000 }); // 開発サーバーは初回表示時に画面を組み立てるため長めに待つ（g34 の初回失敗）
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(invoiceNo) })).toBeVisible();
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('未発行');
    await expect(page.getByRole('region', { name: '請求書の金額' })).toContainText('¥8,844');

    // 発行 → worker が鏡・明細の PDF を作ると「発行済み」（画面は自動で再読込）
    await page.getByRole('button', { name: '請求書を発行（PDF 作成）' }).click();
    await expect(page.getByRole('status')).toContainText('請求書PDFの作成を受け付けました');
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('発行済み', { timeout: 120_000 });
    const coverLink = page.getByRole('link', { name: /^請求書_.*\.pdf$/ });
    await expect(coverLink).toBeVisible();
    await expect(page.getByRole('link', { name: /^請求明細_.*\.pdf$/ })).toBeVisible();
    const pdf = await admin.get(String(await coverLink.getAttribute('href')));
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');

    // 送付 → Mailpit に件名【請求書送付】・添付2件
    await expect(page.getByText(`e2e-inv-${code.toLowerCase()}@example.com`).first()).toBeVisible();
    await page.getByRole('button', { name: 'お客様へ送付' }).click();
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('送付済み', { timeout: 120_000 });
    await expect
      .poll(async () => {
        const r = await admin.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${invoiceNo}"`)}`);
        const messages = ((await r.json()) as { messages: Array<{ Subject: string; Attachments: number }> }).messages;
        return messages.map((m) => `${m.Subject}|${m.Attachments}`);
      }, { timeout: 60_000 })
      .toEqual([`【請求書送付】${Number(MONTH.slice(0, 4))}年${Number(MONTH.slice(5, 7))}月分 ${invoiceNo}|2`]);

    // 遅延訂正: 調整を登録（次の請求に入る）→ 有効な調整があるうちは無効化できない → 取消
    await page.getByLabel(/^品番/).selectOption({ label: `${code}-1 請求品1` });
    await page.getByLabel(/^内容/).fill('E2E 数量の訂正');
    await page.getByLabel(/^金額（円）/).fill('-300');
    await page.getByLabel(/^理由/).fill('E2E の訂正');
    await page.getByRole('button', { name: '調整を登録' }).click();
    await expect(page.getByRole('status')).toContainText('調整を登録しました');
    const adjRow = page.getByRole('row').filter({ hasText: 'E2E 数量の訂正' });
    await expect(adjRow).toContainText('未適用');
    await expect(adjRow).toContainText('−¥300');
    await page.getByLabel(/^無効にする理由/).fill('E2E の無効化');
    await expect(page.getByRole('button', { name: '無効にする' })).toBeDisabled();
    await adjRow.getByLabel(/の取消理由$/).fill('E2E の取消');
    await adjRow.getByRole('button', { name: '取り消す' }).click();
    await expect(page.getByRole('status')).toContainText('調整を取り消しました');
    await expect(adjRow).toContainText('取消');

    // 無効化 → 請求書は無効、報告は承認済みに戻る
    await page.getByLabel(/^無効にする理由/).fill('E2E の無効化');
    await page.getByRole('button', { name: '無効にする' }).click();
    await expect(page.getByRole('status')).toContainText('請求書を無効にしました');
    await expect(page.locator('.ix-pagehead .ix-pill')).toHaveText('無効');
    expect((await detailOf(admin, ids[0] as string))['status']).toBe('APPROVED');

    // 後始末: E2E 専用のお客様を無効化（請求の選択肢に残さない。記録は残る）
    const del = await admin.delete(`/api/v1/masters/customers/${String(customer['id'])}`, { headers: { 'x-csrf-token': adminCsrf }, data: { expectedVersion: 1, reason: 'E2E の後片付け' } });
    expect(del.status()).toBe(204);
  });
});
