/**
 * CHG-011 統合試験: 請求書の発行・送付・再送・無効化と遅延訂正の調整（SCR-15 / API-022・023・035〜037 / FR-013・014・019）。
 * 現場入力 → 承認 → 請求確定 の実データを作り、HTTP handler（入口ガード込み）→ InvoiceService / AdjustmentService → DocStore で通しで確かめる。
 * PDF 作成とメール送信は worker の仕事のため、ここでは worker が書く結果（帳票 GENERATED → 請求書 ISSUED、送信 SENT → 請求書 SENT）を直接書いて進める。
 * worker 側の実処理（実 Chromium・Mailpit）は apps/worker の invoice.itest.ts で確かめる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { jstToInstant, type RoleCode } from '@inspexor/domain';
import {
  auditEventsFor,
  billingRunPath,
  C,
  createUser,
  DocIdempotencyRepository,
  documentPath,
  filePath,
  invoicePath,
  mailJobPath,
  reportPath,
  StoreAuditRepository,
  type BillingRunDoc,
  type DocumentJobDoc,
  type InvoiceDoc,
  type MailJobDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { writeSchema } from '../masters/schemas';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { FieldReportService, type FieldReportType } from '../field/field-report-service';
import { fieldCollectionHandlers, fieldConfirmHandlers, recordTransitionHandlers, type FieldRouteDeps } from '../field/field-handlers';
import { AdjustmentService } from './adjustment-service';
import { BillingService } from './billing-service';
import { InvoiceService } from './invoice-service';
import {
  adjustmentActionHandlers,
  adjustmentCollectionHandlers,
  billingActionHandlers,
  billingCollectionHandlers,
  billingItemHandlers,
  invoiceActionHandlers,
  invoiceItemHandlers,
  type BillingRouteDeps,
} from './billing-handlers';

const SECRET = 'c'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z');
const ON = { APPROVAL_ENABLED: 'true', BILLING_ENABLED: 'true', INVOICE_ISSUER_JSON: JSON.stringify({ postalCode: '712-8000', address: '岡山県倉敷市（試験）', registrationNo: 'T1234567890123', bankNote: '○○銀行 本店 普通 1234567' }) };
let env: Record<string, string> = ON;
let t: TestStore;
let field: FieldRouteDeps;
let billing: BillingRouteDeps;
const users: Record<string, string> = {};
const m: Record<string, string> = {};
const r: Record<string, string> = {};

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const schema = (name: string) => {
  const fn = ajv.getSchema(`o#/components/schemas/${name}`);
  if (!fn) throw new Error(name);
  return fn;
};
const valid = (name: string, value: unknown) => expect(schema(name)(value), JSON.stringify(schema(name).errors)).toBe(true);

const mctx = { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW };
async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  return (await new MasterService(t.store, { billing: true }).create(type, writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>, mctx)).id;
}

type Who = 'field' | 'office' | 'admin' | 'auditor';
const ROLE: Record<Who, RoleCode> = { field: 'FIELD', office: 'OFFICE', admin: 'ADMIN', auditor: 'AUDITOR' };
let seq = 0;
const KEY = () => ({ 'idempotency-key': `inv-key-${(seq += 1)}`.padEnd(24, '0') });

function req(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const payload = { sessionId: `sess-${who}`, userId: users[who] as string, displayName: who, roles: [ROLE[who]], issuedAt: '2026-10-08T02:55:00.000Z', lastActivityAt: '2026-10-08T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`sess-${who}`, SECRET), 'content-type': 'application/json', ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Data = Record<string, unknown> & { id: string; version: number; status: string };
type Json = { data?: Data; error?: { code: string; message?: string; fields?: Array<{ path: string; code: string }>; adjustmentIds?: string[] } };
const json = async (res: Response) => (await res.json()) as Json;

async function report(type: FieldReportType, body: Record<string, unknown>): Promise<string> {
  const seg = type === 'WORK' ? 'work-reports' : 'delivery-reports';
  const created = await json(await fieldCollectionHandlers(type, field).POST(req('field', 'POST', seg, body)));
  const id = created.data?.id as string;
  expect((await fieldConfirmHandlers(type, field).POST(req('field', 'POST', `${seg}/${id}/confirm`, { expectedVersion: 1 }, KEY()))).status).toBe(202);
  await t.store.runTransaction(async (tx) => {
    const h = (await tx.get<ReportHeaderDoc>(reportPath(type, id))) as ReportHeaderDoc;
    tx.update(reportPath(type, id), { status: 'SUBMITTED', version: h.version + 1, submittedAt: NOW, documentStatus: 'GENERATED' });
  });
  const h = (await t.store.get<ReportHeaderDoc>(reportPath(type, id))) as ReportHeaderDoc;
  expect((await recordTransitionHandlers(field).POST(req('office', 'POST', `records/${type}/${id}/approve`, { expectedVersion: h.version }, KEY()))).status).toBe(200);
  return id;
}

const work = (date: string, quantity: number) => ({
  workDate: date, reporterId: users['field'], customerId: m['customer'], productId: m['pQ'], workTypeId: m['wt'], lotNo: null,
  workerIds: [m['w1']], startAt: jstToInstant(date, '09:00'), endAt: jstToInstant(date, '10:00'), quantity, defects: [],
});

const runAct = (id: string, action: string, body: Record<string, unknown>) => billingActionHandlers(billing).POST(req('office', 'POST', `billing-runs/${id}/${action}`, body, KEY()));
const getInvoice = async (id: string, who: Who = 'office') => (await json(await invoiceItemHandlers(billing).GET(req(who, 'GET', `invoices/${id}`)))).data as Data;
const invAct = (who: Who, id: string, action: string, body: Record<string, unknown>, key: Record<string, string> = KEY()) =>
  invoiceActionHandlers(billing).POST(req(who, 'POST', `invoices/${id}/${action}`, body, key));
const adjCreate = (who: Who, body: Record<string, unknown>, key: Record<string, string> = KEY()) => adjustmentCollectionHandlers(billing).POST(req(who, 'POST', 'billing-adjustments', body, key));
const adjCancel = (who: Who, id: string, body: Record<string, unknown>) => adjustmentActionHandlers(billing).POST(req(who, 'POST', `billing-adjustments/${id}/cancel`, body, KEY()));

/** 請求 run を作って計算 → 確定。請求書 id を返す */
async function finalizeRun(periodEnd: string): Promise<{ runId: string; invoiceId: string; data: Data }> {
  const created = await json(await billingCollectionHandlers(billing).POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd }, KEY())));
  const runId = created.data?.id as string;
  expect(created.data?.status).toBe('OPEN');
  const calc = await json(await runAct(runId, 'calculate', { expectedVersion: 1 }));
  expect(calc.data?.status, JSON.stringify(calc)).toBe('CALCULATED');
  const fin = await json(await runAct(runId, 'finalize', { expectedVersion: calc.data?.version as number }));
  expect(fin.data?.status, JSON.stringify(fin)).toBe('FINALIZED');
  return { runId, invoiceId: fin.data?.['invoiceId'] as string, data: fin.data as Data };
}

/** worker の代わり: 鏡・明細を作成済みにし、両方そろったら請求書・請求 run を ISSUED にする */
async function workerGenerates(invoiceId: string): Promise<void> {
  await t.store.runTransaction(async (tx) => {
    const inv = (await tx.get<InvoiceDoc>(invoicePath(invoiceId))) as InvoiceDoc;
    const run = (await tx.get<BillingRunDoc>(billingRunPath(inv.billingRunId))) as BillingRunDoc;
    for (const [kind, id] of [['請求書', inv.coverDocumentId as string], ['請求明細', inv.detailDocumentId as string]] as const) {
      const fileId = `${id.slice(0, 8)}-0000-4000-8000-000000000001`;
      tx.set(filePath(fileId), { storageKey: `documents/INVOICE/${kind}_${inv.periodEnd}_${inv.customerSnapshot.code}_${inv.invoiceNo}.pdf`, mimeType: 'application/pdf', sizeBytes: 1000, sha256: 'x'.repeat(64), classification: 'CONFIDENTIAL', createdAt: NOW });
      tx.update(documentPath(id), { status: 'GENERATED', fileId, updatedAt: NOW });
    }
    tx.update(invoicePath(invoiceId), { status: 'ISSUED', version: inv.version + 1, issuedAt: NOW, updatedAt: NOW });
    tx.update(billingRunPath(inv.billingRunId), { status: 'ISSUED', version: run.version + 1, updatedAt: NOW });
  });
}

/** worker の代わり: 送信完了 → 請求書 SENT（請求 run は ISSUED のときだけ SENT） */
async function workerSends(invoiceId: string, mailId: string): Promise<void> {
  await t.store.runTransaction(async (tx) => {
    const inv = (await tx.get<InvoiceDoc>(invoicePath(invoiceId))) as InvoiceDoc;
    const run = (await tx.get<BillingRunDoc>(billingRunPath(inv.billingRunId))) as BillingRunDoc;
    tx.update(mailJobPath(mailId), { status: 'SENT', providerMessageId: 'msg-1', updatedAt: NOW });
    tx.update(invoicePath(invoiceId), { status: 'SENT', version: inv.version + 1, sentAt: NOW, sendCount: (inv.sendCount ?? 0) + 1, updatedAt: NOW });
    if (run.status === 'ISSUED') tx.update(billingRunPath(inv.billingRunId), { status: 'SENT', version: run.version + 1, updatedAt: NOW });
  });
}

beforeAll(async () => {
  t = createTestStore('invoices');
  for (const who of Object.keys(ROLE) as Who[]) users[who] = (await createUser(t.store, { loginId: `inv-${who}`, passwordHash: 'x', displayName: who, roles: [ROLE[who]] }, NOW)) as string;
  m['customer'] = await master('customers', { code: 'CI1', name: '請求書顧客', closingDay: 31 });
  m['pQ'] = await master('products', { customerId: m['customer'], code: 'I-Q', name: '数量品', settlementType: 'QUANTITY' });
  m['pX'] = await master('products', { customerId: m['customer'], code: 'I-X', name: '別品番', settlementType: 'QUANTITY' });
  m['otherCustomer'] = await master('customers', { code: 'CI2', name: '別顧客', closingDay: 31 });
  m['pOther'] = await master('products', { customerId: m['otherCustomer'], code: 'O-Q', name: '別顧客品', settlementType: 'QUANTITY' });
  m['wt'] = await master('work-types', { productId: m['pQ'], code: 'INSP', name: '検査' });
  m['w1'] = await master('workers', { code: 'IW1', name: '作業者' });
  await master('rates', { productId: m['pQ'], unitPrice: '5', validFrom: '2026-01-01' });
  field = {
    service: () => new FieldReportService(t.store),
    idempotency: () => new DocIdempotencyRepository(t.store, () => NOW),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined }),
    env: () => env,
  };
  billing = {
    service: () => new BillingService(t.store),
    invoices: () => new InvoiceService(t.store, SECRET, () => env),
    adjustments: () => new AdjustmentService(t.store),
    idempotency: field.idempotency,
    api: field.api,
    env: () => env,
  };
  r['w1'] = await report('WORK', work('2026-09-07', 1000));
  r['w2'] = await report('WORK', work('2026-09-08', 200));
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('CHG-011: 請求書の参照と発行', () => {
  it('BILLING_ENABLED が無いと 404。AUDITOR は参照だけ、FIELD は 403', async () => {
    const { invoiceId, runId } = await finalizeRun('2026-09-30');
    r['inv1'] = invoiceId;
    r['run1'] = runId;
    env = { APPROVAL_ENABLED: 'true' };
    expect((await invoiceItemHandlers(billing).GET(req('office', 'GET', `invoices/${invoiceId}`))).status).toBe(404);
    expect((await adjustmentCollectionHandlers(billing).GET(req('office', 'GET', 'billing-adjustments'))).status).toBe(404);
    env = ON;
    expect((await invoiceItemHandlers(billing).GET(req('auditor', 'GET', `invoices/${invoiceId}`))).status).toBe(200);
    expect((await invoiceItemHandlers(billing).GET(req('field', 'GET', `invoices/${invoiceId}`))).status).toBe(403);
    expect((await invAct('auditor', invoiceId, 'issue', { expectedVersion: 1 })).status).toBe(403);
    expect((await invoiceItemHandlers(billing).GET(req('office', 'GET', 'invoices/00000000-0000-4000-8000-000000000000'))).status).toBe(404);
    expect((await invAct('office', invoiceId, 'print', { expectedVersion: 1 })).status).toBe(404);
  });

  it('参照: 版付きの番号（INV-年月-コード-001）・対象期間・明細・送付先の候補。発行前は帳票なし', async () => {
    await master('contacts', { customerId: m['customer'], code: 'C1', name: '経理', email: 'Keiri@Example.com', sendInvoice: true });
    await master('contacts', { customerId: m['customer'], code: 'C2', name: '日報のみ', email: 'daily@example.com', sendDaily: true });
    await master('contacts', { customerId: m['customer'], code: 'C3', name: '別品番担当', email: 'x@example.com', sendInvoice: true, invoiceProductIds: [m['pX']] });
    const d = await getInvoice(r['inv1'] as string);
    valid('InvoiceDetail', d);
    expect(d).toMatchObject({ invoiceNo: 'INV-202609-CI1-001', baseInvoiceNo: 'INV-202609-CI1', revision: 1, status: 'FINALIZED', periodLabel: '2026年9月分', subtotalYen: 6000, taxYen: 600, totalYen: 6600, issueCount: 0, issueDate: null, documents: [], mails: [] });
    expect(d['recipients']).toEqual(['keiri@example.com']);
    expect((d['lines'] as Array<Record<string, unknown>>).map((l) => [l['no'], l['lineType'], l['amountYen']])).toEqual([[1, 'WORK_QUANTITY', 5000], [2, 'WORK_QUANTITY', 1000]]);
    // 請求 run の一覧・詳細も版付きの番号
    const run = (await json(await billingItemHandlers(billing).GET(req('office', 'GET', `billing-runs/${r['run1']}`)))).data as Data;
    expect(run['invoiceNo']).toBe('INV-202609-CI1-001');
  });

  it('発行前の送付は 409。発行: 鏡・明細の帳票 job を作り、発行元・発行日・支払期限（翌月末）を記録（202、Idempotency-Key で replay）', async () => {
    const id = r['inv1'] as string;
    expect((await invAct('office', id, 'send', { expectedVersion: 1 })).status).toBe(409);
    expect((await invAct('office', id, 'issue', { expectedVersion: 1 }, {})).status).toBe(422);
    expect((await invAct('office', id, 'issue', { expectedVersion: 9 })).status).toBe(409);
    const key = KEY();
    const res = await invAct('office', id, 'issue', { expectedVersion: 1 }, key);
    expect(res.status).toBe(202);
    const d = (await json(res)).data as Data;
    valid('InvoiceDetail', d);
    expect(d).toMatchObject({ status: 'FINALIZED', version: 2, issueCount: 1, issueDate: '2026-10-08', dueDate: '2026-10-31' });
    expect(d['issuer']).toMatchObject({ name: '三成興業株式会社', tel: '086-448-1930', postalCode: '712-8000', registrationNo: 'T1234567890123' });
    const docs = d['documents'] as Array<Record<string, unknown>>;
    expect(docs.map((x) => [x['kind'], x['templateVersion'], x['status'], x['url']])).toEqual([
      ['COVER', 'INVOICE_COVER_V1', 'QUEUED', null],
      ['DETAIL', 'INVOICE_DETAIL_V1', 'QUEUED', null],
    ]);
    const job = (await t.store.get<DocumentJobDoc>(documentPath(docs[0]?.['id'] as string))) as DocumentJobDoc;
    expect(job).toMatchObject({ sourceType: 'INVOICE', reportType: 'INVOICE', reportId: id, documentType: 'INVOICE_COVER', revisionNo: 1 });
    expect((await invAct('office', id, 'issue', { expectedVersion: 1 }, key)).headers.get('idempotent-replayed')).toBe('true');
    // 作成中は二重発行できない
    expect((await invAct('office', id, 'issue', { expectedVersion: 2 })).status).toBe(409);
    expect((await auditEventsFor(t.store, 'INVOICE', id)).map((a) => a.action)).toContain('INVOICE_ISSUE_REQUEST');
  });

  it('帳票が作成済みになると ISSUED。PDF の署名 URL を返す', async () => {
    await workerGenerates(r['inv1'] as string);
    const d = await getInvoice(r['inv1'] as string);
    valid('InvoiceDetail', d);
    expect(d['status']).toBe('ISSUED');
    for (const x of d['documents'] as Array<Record<string, unknown>>) {
      expect(x['status']).toBe('GENERATED');
      expect(String(x['url'])).toMatch(/^\/api\/files\/.+\?exp=\d+&sig=/);
      expect(String(x['fileName'])).toMatch(/\.pdf$/);
    }
    expect((await t.store.get<BillingRunDoc>(billingRunPath(r['run1'] as string)))?.status).toBe('ISSUED');
  });
});

describe('CHG-011: 送付・再送', () => {
  it('送付: 件名【請求書送付】・宛先・添付2件の送信 job（宛先・本文は監査に残さない）。送信済みの再送付は 409', async () => {
    const id = r['inv1'] as string;
    const v = (await getInvoice(id)).version;
    const res = await invAct('office', id, 'send', { expectedVersion: v });
    expect(res.status).toBe(202);
    const d = (await json(res)).data as Data;
    const mails = d['mails'] as Array<Record<string, unknown>>;
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ sendRevision: 1, status: 'QUEUED', to: ['keiri@example.com'], subject: '【請求書送付】2026年9月分 INV-202609-CI1-001', errorCode: null });
    const job = (await t.store.get<MailJobDoc>(mailJobPath(mails[0]?.['id'] as string))) as MailJobDoc;
    expect(job.documentJobIds).toHaveLength(2);
    expect(job.recipients.attachmentNames).toHaveLength(2);
    expect(job.recipients.text).toContain('6,600円');
    const audit = (await auditEventsFor(t.store, 'INVOICE', id)).find((a) => a.action === 'INVOICE_SEND_REQUEST');
    expect(JSON.stringify(audit)).not.toContain('keiri@example.com');
    // 送信中は送付・再送・無効化できない
    expect((await invAct('office', id, 'void', { expectedVersion: d.version, reason: 'x' })).status).toBe(409);
    await workerSends(id, mails[0]?.['id'] as string);
    const sent = await getInvoice(id);
    expect(sent['status']).toBe('SENT');
    expect((await invAct('office', id, 'send', { expectedVersion: sent.version })).status).toBe(409);
    expect((await t.store.get<BillingRunDoc>(billingRunPath(r['run1'] as string)))?.status).toBe('SENT');
  });

  it('再送: 理由必須（422）。理由付きで2回目の送信 job（sendRevision 2）', async () => {
    const id = r['inv1'] as string;
    const v = (await getInvoice(id)).version;
    const no = await json(await invAct('office', id, 'resend', { expectedVersion: v }));
    expect(no.error?.fields?.[0]).toMatchObject({ path: '/reason' });
    const d = (await json(await invAct('admin', id, 'resend', { expectedVersion: v, reason: '先方の受信漏れ' }))).data as Data;
    const mails = d['mails'] as Array<Record<string, unknown>>;
    expect(mails.map((x) => [x['sendRevision'], x['reason']])).toEqual([[1, null], [2, '先方の受信漏れ']]);
    await workerSends(id, mails[1]?.['id'] as string);
    expect((await getInvoice(id))['status']).toBe('SENT');
  });
});

describe('CHG-011: 遅延訂正の調整（次の請求期間に入れる）', () => {
  it('登録: 入力検証（0円・説明・理由）、品番はお客様の品番、元の報告はこの請求書の報告。FIELD・AUDITOR は 403', async () => {
    const base = { sourceInvoiceId: r['inv1'], productId: m['pQ'], description: '9/7 検査数の訂正', amountYen: -500, reason: '数量の入力誤り' };
    expect((await adjCreate('field', base)).status).toBe(403);
    expect((await adjCreate('auditor', base)).status).toBe(403);
    expect((await adjCreate('office', base, {})).status).toBe(422);
    expect((await json(await adjCreate('office', { ...base, amountYen: 0 }))).error?.fields?.[0]).toMatchObject({ path: '/amountYen' });
    expect((await json(await adjCreate('office', { ...base, reason: ' ' }))).error?.fields?.[0]).toMatchObject({ path: '/reason' });
    expect((await json(await adjCreate('office', { ...base, productId: m['pOther'] }))).error?.fields?.[0]).toMatchObject({ path: '/productId' });
    const otherReport = await report('WORK', work('2026-10-02', 10));
    r['wOct'] = otherReport;
    expect((await json(await adjCreate('office', { ...base, sourceReportId: otherReport }))).error?.fields?.[0]).toMatchObject({ path: '/sourceReportId' });
    const res = await adjCreate('office', { ...base, sourceReportId: r['w1'] });
    expect(res.status).toBe(201);
    const a = (await json(res)).data as Data;
    valid('BillingAdjustment', a);
    expect(a).toMatchObject({ status: 'PENDING', version: 1, sourceInvoiceNo: 'INV-202609-CI1-001', applyFrom: '2026-10-01', amountYen: -500, productCode: 'I-Q' });
    expect(String(a['sourceReportNo'])).not.toBe('');
    r['adj1'] = a.id;
    const extra = (await json(await adjCreate('office', { ...base, amountYen: 300, description: '取り消す調整' }))).data as Data;
    r['adj2'] = extra.id;
    const list = (await json(await adjustmentCollectionHandlers(billing).GET(req('auditor', 'GET', `billing-adjustments?customerId=${m['customer']}&status=PENDING`)))).data as unknown as Data[];
    expect(list.map((x) => x.id).sort()).toEqual([r['adj1'], r['adj2']].sort());
    expect((await adjustmentCollectionHandlers(billing).GET(req('office', 'GET', 'billing-adjustments?status=X'))).status).toBe(400);
    expect(((await getInvoice(r['inv1'] as string))['adjustments'] as unknown[]).length).toBe(2);
  });

  it('取消: 理由必須・version 照合・取消済みは 409', async () => {
    const id = r['adj2'] as string;
    expect((await adjCancel('office', id, { expectedVersion: 1 })).status).toBe(422);
    expect((await adjCancel('office', id, { expectedVersion: 9, reason: '不要' })).status).toBe(409);
    const ok = await json(await adjCancel('office', id, { expectedVersion: 1, reason: '不要になった' }));
    expect(ok.data).toMatchObject({ status: 'CANCELLED', version: 2, cancelReason: '不要になった' });
    expect((await adjCancel('office', id, { expectedVersion: 2, reason: '再取消' })).status).toBe(409);
  });

  it('元の請求書に有効な調整があると無効化できない（409）', async () => {
    const id = r['inv1'] as string;
    const v = (await getInvoice(id)).version;
    const res = await json(await invAct('office', id, 'void', { expectedVersion: v, reason: '誤り' }));
    expect(res.error?.code).toBe('STATE_CONFLICT');
    expect(res.error?.adjustmentIds).toEqual([r['adj1']]);
  });

  it('次の請求（10月分）の明細に調整行が入り、確定で APPLIED。確定後に調整が増えたら計算し直し（SOURCE_CHANGED）', async () => {
    const created = await json(await billingCollectionHandlers(billing).POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-10-31' }, KEY())));
    const runId = created.data?.id as string;
    r['run2'] = runId;
    const calc = await json(await runAct(runId, 'calculate', { expectedVersion: 1 }));
    const lines = (calc.data?.['lines'] as Array<Record<string, unknown>>).map((l) => [l['lineType'], l['amountYen'], l['description']]);
    expect(lines).toEqual([
      ['WORK_QUANTITY', 50, expect.any(String)],
      ['ADJUSTMENT', -500, '調整 9/7 検査数の訂正（INV-202609-CI1-001 の訂正）'],
    ]);
    // 合計が負になるので警告（NEGATIVE_INVOICE）→ 要確認
    expect(calc.data).toMatchObject({ subtotalYen: -450, status: 'NEEDS_REVIEW' });
    expect((calc.data?.['warnings'] as Array<Record<string, unknown>>).map((w) => w['code'])).toEqual(['NEGATIVE_INVOICE']);
    const late = (await json(await adjCreate('office', { sourceInvoiceId: r['inv1'], productId: m['pX'], description: '追加の訂正', amountYen: 1000, reason: '請求漏れ' }))).data as Data;
    const re = await json(await runAct(runId, 'calculate', { expectedVersion: calc.data?.version as number }));
    expect(re.data?.status).toBe('CALCULATED');
    // 並び: 日付なし → 元の報告番号（無いものが先）→ 品番
    expect((re.data?.['lines'] as Array<Record<string, unknown>>).filter((l) => l['lineType'] === 'ADJUSTMENT').map((l) => [l['productCode'], l['amountYen']])).toEqual([
      ['I-X', 1000],
      ['I-Q', -500],
    ]);
    // 計算の後に調整が増えたら確定できない（SOURCE_CHANGED）。その調整を取り消せば確定できる
    const extra = (await json(await adjCreate('office', { sourceInvoiceId: r['inv1'], productId: m['pQ'], description: '後から', amountYen: 1, reason: '試験' }))).data as Data;
    const stale = await json(await runAct(runId, 'finalize', { expectedVersion: re.data?.version as number }));
    expect(stale.error?.code).toBe('SOURCE_CHANGED');
    expect((await adjCancel('office', extra.id, { expectedVersion: 1, reason: '登録の誤り' })).status).toBe(200);
    const fin = await json(await runAct(runId, 'finalize', { expectedVersion: re.data?.version as number }));
    expect(fin.data).toMatchObject({ status: 'FINALIZED', invoiceNo: 'INV-202610-CI1-001', subtotalYen: 550 });
    r['inv2'] = fin.data?.['invoiceId'] as string;
    const inv2 = await getInvoice(r['inv2'] as string);
    expect((inv2['appliedAdjustments'] as Data[]).map((a) => a.id).sort()).toEqual([r['adj1'], late.id].sort());
    expect((inv2['lines'] as Array<Record<string, unknown>>).some((l) => l['lineType'] === 'ADJUSTMENT')).toBe(true);
    const applied = (await json(await adjustmentCollectionHandlers(billing).GET(req('office', 'GET', `billing-adjustments?status=APPLIED`)))).data as unknown as Data[];
    expect(applied.map((a) => [a.id, a['appliedInvoiceId']]).sort()).toEqual([[r['adj1'], r['inv2']], [late.id, r['inv2']]].sort());
    // 適用済みは取消できない
    expect((await adjCancel('office', late.id, { expectedVersion: 2, reason: 'x' })).status).toBe(409);
    r['adj3'] = late.id;
  });
});

describe('CHG-011: 無効化と作り直し（版+1）', () => {
  it('調整を適用した請求書（10月分）を無効化 → 調整は未適用（PENDING）に戻り、報告は承認済み、同じ期間を作り直すと版 002', async () => {
    const id = r['inv2'] as string;
    const v = (await getInvoice(id)).version;
    expect((await invAct('office', id, 'void', { expectedVersion: v })).status).toBe(422);
    const res = await invAct('office', id, 'void', { expectedVersion: v, reason: '金額の誤り' });
    expect(res.status).toBe(200);
    const d = (await json(res)).data as Data;
    valid('InvoiceDetail', d);
    expect(d).toMatchObject({ status: 'VOIDED', voidReason: '金額の誤り', appliedAdjustments: [] });
    expect((await t.store.get<BillingRunDoc>(billingRunPath(r['run2'] as string)))?.status).toBe('VOIDED');
    expect((await t.store.get<ReportHeaderDoc>(reportPath('WORK', r['wOct'] as string)))).toMatchObject({ status: 'APPROVED', billingRunId: null });
    const pending = (await json(await adjustmentCollectionHandlers(billing).GET(req('office', 'GET', `billing-adjustments?customerId=${m['customer']}&status=PENDING`)))).data as unknown as Data[];
    expect(pending.map((a) => a.id).sort()).toEqual([r['adj1'], r['adj3']].sort());
    // 無効化済みには何もできない。無効化した請求書を元に調整は登録できない
    expect((await invAct('office', id, 'void', { expectedVersion: d.version, reason: 'x' })).status).toBe(409);
    expect((await invAct('office', id, 'issue', { expectedVersion: d.version })).status).toBe(409);
    expect((await adjCreate('office', { sourceInvoiceId: id, productId: m['pQ'], description: 'x', amountYen: 1, reason: 'x' })).status).toBe(409);
    // 作り直し → 版 002（調整も入る）
    const again = await finalizeRun('2026-10-31');
    expect(again.data).toMatchObject({ invoiceNo: 'INV-202610-CI1-002', subtotalYen: 550 });
    const inv = (await t.store.get<InvoiceDoc>(invoicePath(again.invoiceId))) as InvoiceDoc;
    expect(inv).toMatchObject({ invoiceNo: 'INV-202610-CI1', revision: 2 });
    expect((await t.store.get<ReportHeaderDoc>(reportPath('WORK', r['wOct'] as string)))?.status).toBe('BILLING_LOCKED');
    expect((await auditEventsFor(t.store, 'INVOICE', id)).map((a) => a.action)).toContain('INVOICE_VOID');
  });

  it('確定済みの請求 run は請求 run 画面では取消できない（請求書の無効化へ誘導、409）', async () => {
    const run = (await t.store.query<BillingRunDoc>(C.billingRuns)).find((x) => x.data.status === 'FINALIZED') as { id: string; data: BillingRunDoc };
    const res = await json(await runAct(run.id, 'void', { expectedVersion: run.data.version, reason: 'x' }));
    expect(res.error?.code).toBe('STATE_CONFLICT');
    expect(res.error?.message).toContain('請求書の画面');
  });

  it('宛先0件のお客様は送信 job を FAILED_FINAL（RECIPIENT_EMPTY）で記録する', async () => {
    const created = await json(await billingCollectionHandlers(billing).POST(req('office', 'POST', 'billing-runs', { customerId: m['otherCustomer'], periodEnd: '2026-09-30' }, KEY())));
    const runId = created.data?.id as string;
    const calc = await json(await runAct(runId, 'calculate', { expectedVersion: 1 }));
    const fin = await json(await runAct(runId, 'finalize', { expectedVersion: calc.data?.version as number }));
    const id = fin.data?.['invoiceId'] as string;
    await invAct('office', id, 'issue', { expectedVersion: 1 });
    await workerGenerates(id);
    const d = (await json(await invAct('office', id, 'send', { expectedVersion: (await getInvoice(id)).version }))).data as Data;
    expect(d['recipients']).toEqual([]);
    expect((d['mails'] as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'FAILED_FINAL', errorCode: 'RECIPIENT_EMPTY', to: [] });
    expect(d['status']).toBe('ISSUED');
    // 失敗した送付の後は「再送」（理由付き）で送り直す
    expect((await invAct('office', id, 'send', { expectedVersion: d.version })).status).toBe(409);
  });
});
