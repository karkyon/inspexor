/**
 * CHG-009 統合試験: 請求計算・レビュー・確定（SCR-14 / API-019〜021・034 / FR-009〜014 / T-BIL-001）。
 * 現場入力 → 確定 → （帳票作成の代わりに）提出済 → 承認 の実データを作り、HTTP handler（入口ガード込み）→ BillingService → DocStore で通しで確かめる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { jstToInstant, type RoleCode } from '@inspexor/domain';
import { auditEventsFor, C, createUser, DocIdempotencyRepository, invoicePath, reportPath, StoreAuditRepository, type InvoiceDoc, type ReportHeaderDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { updateSchema, writeSchema } from '../masters/schemas';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { FieldReportService, type FieldReportType } from '../field/field-report-service';
import { fieldCollectionHandlers, fieldConfirmHandlers, recordTransitionHandlers, type FieldRouteDeps } from '../field/field-handlers';
import { BillingService } from './billing-service';
import { billingActionHandlers, billingCollectionHandlers, billingItemHandlers, type BillingRouteDeps } from './billing-handlers';

const SECRET = 'b'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z');
const ON = { APPROVAL_ENABLED: 'true', BILLING_ENABLED: 'true' };
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

const masters = () => new MasterService(t.store, { billing: true });
const mctx = { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW };
async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  return (await masters().create(type, writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>, mctx)).id;
}

type Who = 'field' | 'office' | 'admin' | 'auditor';
const ROLE: Record<Who, RoleCode> = { field: 'FIELD', office: 'OFFICE', admin: 'ADMIN', auditor: 'AUDITOR' };
let seq = 0;
const KEY = () => ({ 'idempotency-key': `bil-key-${(seq += 1)}`.padEnd(24, '0') });

function req(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const payload = { sessionId: `sess-${who}`, userId: users[who] as string, displayName: who, roles: [ROLE[who]], issuedAt: '2026-10-08T02:55:00.000Z', lastActivityAt: '2026-10-08T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`sess-${who}`, SECRET), 'content-type': 'application/json', ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Json = { data?: Record<string, unknown> & { id: string; version: number; status: string }; error?: { code: string; fields?: Array<{ path: string; code: string }>; existingRunId?: string; changedReports?: string[] } };
const json = async (res: Response) => (await res.json()) as Json;

/** 現場が作って確定 → 提出済（帳票作成の代わり）→ 事務所が承認（approve=false なら提出済のまま） */
async function report(type: FieldReportType, body: Record<string, unknown>, approve = true): Promise<string> {
  const seg = type === 'WORK' ? 'work-reports' : 'delivery-reports';
  const created = await json(await fieldCollectionHandlers(type, field).POST(req('field', 'POST', seg, body)));
  const id = created.data?.id as string;
  expect((await fieldConfirmHandlers(type, field).POST(req('field', 'POST', `${seg}/${id}/confirm`, { expectedVersion: 1 }, KEY()))).status).toBe(202);
  await t.store.runTransaction(async (tx) => {
    const h = (await tx.get<ReportHeaderDoc>(reportPath(type, id))) as ReportHeaderDoc;
    tx.update(reportPath(type, id), { status: 'SUBMITTED', version: h.version + 1, submittedAt: NOW, documentStatus: 'GENERATED' });
  });
  if (approve) await approveReport(type, id);
  return id;
}

async function approveReport(type: FieldReportType, id: string): Promise<void> {
  const h = (await t.store.get<ReportHeaderDoc>(reportPath(type, id))) as ReportHeaderDoc;
  const res = await recordTransitionHandlers(field).POST(req('office', 'POST', `records/${type}/${id}/approve`, { expectedVersion: h.version }, KEY()));
  expect(res.status).toBe(200);
}

const work = (date: string, productId: string, workTypeId: string, start: string, end: string, quantity: number) => ({
  workDate: date, reporterId: users['field'], customerId: m['customer'], productId, workTypeId, lotNo: null,
  workerIds: [m['w1']], startAt: jstToInstant(date, start), endAt: jstToInstant(date, end), quantity, defects: [],
});

const runs = () => billingCollectionHandlers(billing);
const item = () => billingItemHandlers(billing);
const act = (who: Who, id: string, action: string, body: Record<string, unknown>, key = KEY()) => billingActionHandlers(billing).POST(req(who, 'POST', `billing-runs/${id}/${action}`, body, key));

beforeAll(async () => {
  t = createTestStore('billing');
  for (const who of Object.keys(ROLE) as Who[]) users[who] = (await createUser(t.store, { loginId: `bil-${who}`, passwordHash: 'x', displayName: who, roles: [ROLE[who]] }, NOW)) as string;
  m['customer'] = await master('customers', { code: 'CB1', name: '請求顧客', closingDay: 31 });
  m['pQ'] = await master('products', { customerId: m['customer'], code: 'B-Q', name: '数量品', settlementType: 'QUANTITY' });
  m['pT'] = await master('products', { customerId: m['customer'], code: 'B-T', name: '時間品', settlementType: 'TIME' });
  m['pN'] = await master('products', { customerId: m['customer'], code: 'B-N', name: '単価なし品', settlementType: 'QUANTITY' });
  for (const p of ['pQ', 'pT', 'pN']) m[`wt-${p}`] = await master('work-types', { productId: m[p], code: 'INSP', name: '検査' });
  m['w1'] = await master('workers', { code: 'BW1', name: '作業者' });
  m['rateQ'] = await master('rates', { productId: m['pQ'], unitPrice: '4.4', validFrom: '2026-01-01' });
  m['rateT'] = await master('rates', { productId: m['pT'], workTypeId: m['wt-pT'], unitPrice: '1980', validFrom: '2026-01-01' });
  for (const p of ['pQ', 'pT', 'pN']) await master('transport-rules', { productId: m[p], transportType: 'ALLOCATED', amountYen: 2500, validFrom: '2026-01-01' });
  await master('fixed-charges', { productId: m['pQ'], label: '保管料', amountYen: 5000, validFrom: '2026-01-01' });
  field = {
    service: () => new FieldReportService(t.store),
    idempotency: () => new DocIdempotencyRepository(t.store, () => NOW),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined }),
    env: () => env,
  };
  billing = { service: () => new BillingService(t.store), idempotency: field.idempotency, api: field.api, env: () => env };

  r['w1'] = await report('WORK', work('2026-09-07', m['pQ'] as string, m['wt-pQ'] as string, '09:00', '10:00', 1600));
  r['w2'] = await report('WORK', work('2026-09-07', m['pT'] as string, m['wt-pT'] as string, '16:30', '18:00', 10));
  r['w3'] = await report('WORK', work('2026-09-08', m['pN'] as string, m['wt-pN'] as string, '09:00', '10:00', 5));
  r['w4'] = await report('WORK', work('2026-09-10', m['pQ'] as string, m['wt-pQ'] as string, '09:00', '10:00', 100), false);
  r['wOther'] = await report('WORK', work('2026-10-01', m['pQ'] as string, m['wt-pQ'] as string, '09:00', '10:00', 1));
  r['d1'] = await report('DELIVERY', {
    deliveryDate: '2026-09-09', driverId: m['w1'], customerId: m['customer'], vehicleId: null, tripCount: 1,
    items: [{ productId: m['pQ'], quantity: 10 }, { productId: m['pT'], quantity: 5 }, { productId: m['pN'], quantity: 1 }],
  });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('CHG-009: 請求機能の有効化と作成', () => {
  it('BILLING_ENABLED が無い（または APPROVAL_ENABLED が無い）と 404', async () => {
    for (const e of [{}, { BILLING_ENABLED: 'true' }, { APPROVAL_ENABLED: 'true' }]) {
      env = e;
      expect((await runs().GET(req('office', 'GET', 'billing-runs'))).status).toBe(404);
    }
    env = ON;
  });

  it('作成: 締め日でない日付は 422、現場（FIELD）は 403、Idempotency-Key 必須。同じ期間は 409（既存の run を返す）', async () => {
    const bad = await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-29' }, KEY()));
    expect(bad.status).toBe(422);
    expect((await json(bad)).error?.fields?.[0]).toMatchObject({ path: '/periodEnd', code: 'closing_day' });
    expect((await runs().POST(req('field', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-30' }, KEY()))).status).toBe(403);
    expect((await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-30' }))).status).toBe(422);
    const key = KEY();
    const ok = await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-30' }, key));
    expect(ok.status).toBe(201);
    const run = (await json(ok)).data as NonNullable<Json['data']>;
    expect(run).toMatchObject({ status: 'OPEN', version: 1, calcVersion: 0, periodStart: '2026-09-01', periodEnd: '2026-09-30', customerCode: 'CB1' });
    expect(schema('BillingRun')(run), JSON.stringify(schema('BillingRun').errors)).toBe(true);
    r['run'] = run.id;
    // 同じ key は同じ応答（replay）、別 key は 409 で既存の run を示す
    const replay = await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-30' }, key));
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const dup = await json(await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-09-30' }, KEY())));
    expect(dup.error).toMatchObject({ code: 'STATE_CONFLICT', existingRunId: run.id });
  });
});

describe('CHG-009: 計算 → レビュー → 確定', () => {
  it('計算: 承認済みの現在版だけ。数量×単価・通常/割増・運搬按分・固定費、単価ルールが無い報告は警告 → NEEDS_REVIEW', async () => {
    const res = await act('office', r['run'] as string, 'calculate', { expectedVersion: 1 });
    expect(res.status).toBe(200);
    const d = (await json(res)).data as unknown as Record<string, unknown> & { lines: Array<Record<string, unknown>>; warnings: Array<Record<string, unknown>> };
    expect(schema('BillingRunDetail')(d), JSON.stringify(schema('BillingRunDetail').errors)).toBe(true);
    expect(d).toMatchObject({ status: 'NEEDS_REVIEW', calcVersion: 1, viewingCalcVersion: 1, sourceCount: 4, unapprovedCount: 1, warningCount: 1, openWarningCount: 1 });
    expect(d.lines.map((l) => [l['lineType'], l['productCode'], l['amountYen']])).toEqual([
      ['WORK_QUANTITY', 'B-Q', 7040],
      ['WORK_REGULAR', 'B-T', 990],
      ['WORK_OVERTIME', 'B-T', 2475],
      ['TRANSPORT_ALLOCATED', 'B-N', 834],
      ['TRANSPORT_ALLOCATED', 'B-Q', 833],
      ['TRANSPORT_ALLOCATED', 'B-T', 833],
      ['FIXED_CHARGE', 'B-Q', 5000],
    ]);
    expect(d).toMatchObject({ subtotalYen: 18005, taxYen: 1801, totalYen: 19806 });
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatchObject({ code: 'RULE_NOT_FOUND', reportId: r['w3'], productCode: 'B-N', disposition: null });
    expect(typeof d['runHash']).toBe('string');
    expect((await auditEventsFor(t.store, 'BILLING_RUN', r['run'] as string)).map((a) => a.action).sort()).toEqual(['BILLING_RUN_CALCULATE', 'BILLING_RUN_CALCULATED', 'BILLING_RUN_CREATE']);
  });

  it('警告が残る間は確定できない（409）。AUDITOR は参照だけ（操作は 403）', async () => {
    expect((await act('office', r['run'] as string, 'finalize', { expectedVersion: 3 })).status).toBe(409);
    expect((await item().GET(req('auditor', 'GET', `billing-runs/${r['run']}`))).status).toBe(200);
    expect((await act('auditor', r['run'] as string, 'calculate', { expectedVersion: 3 })).status).toBe(403);
  });

  it('レビュー: 理由必須・全警告に処置が必要・version 照合。EXCLUDE した報告は除外 → REVIEWED', async () => {
    const run = r['run'] as string;
    const d = (await json(await item().GET(req('office', 'GET', `billing-runs/${run}`)))).data as unknown as Record<string, unknown> & { warnings: Array<{ id: string }> };
    const wid = d.warnings[0]?.id as string;
    expect((await act('office', run, 'review', { expectedVersion: 3, reason: '', resolutions: [{ warningId: wid, resolution: 'EXCLUDE' }] })).status).toBe(422);
    const none = await json(await act('office', run, 'review', { expectedVersion: 3, reason: '確認済み', resolutions: [] }));
    expect(none.error?.fields?.[0]).toMatchObject({ path: '/resolutions', code: 'required' });
    expect((await act('office', run, 'review', { expectedVersion: 2, reason: '確認済み', resolutions: [{ warningId: wid, resolution: 'EXCLUDE' }] })).status).toBe(409);
    const ok = await act('office', run, 'review', { expectedVersion: 3, reason: '単価未設定の品番は今月は請求しない', resolutions: [{ warningId: wid, resolution: 'EXCLUDE' }] });
    expect(ok.status).toBe(200);
    const v = (await json(ok)).data as unknown as Record<string, unknown> & { warnings: Array<{ disposition: unknown }> };
    expect(v).toMatchObject({ status: 'REVIEWED', version: 4, openWarningCount: 0, excludedReportIds: [r['w3']], totalYen: 19806, reviewReason: '単価未設定の品番は今月は請求しない' });
    expect(v.warnings[0]?.disposition).toMatchObject({ resolution: 'EXCLUDE', by: users['office'] });
  });

  it('確定: 計算後に期間内の報告が承認されたら 409 SOURCE_CHANGED → 再計算（新しい計算版、旧版は残る）', async () => {
    const run = r['run'] as string;
    await approveReport('WORK', r['w4'] as string);
    const changed = await json(await act('office', run, 'finalize', { expectedVersion: 4 }));
    expect(changed.error?.code).toBe('SOURCE_CHANGED');
    const re = await json(await act('office', run, 'calculate', { expectedVersion: 4 }));
    expect(re.data).toMatchObject({ status: 'NEEDS_REVIEW', calcVersion: 2, sourceCount: 5, unapprovedCount: 0, excludedReportIds: [], subtotalYen: 18005 + 440 });
    expect((re.data?.['calcs'] as unknown[]).length).toBe(2);
    const old = (await json(await item().GET(req('office', 'GET', `billing-runs/${run}?calcVersion=1`)))).data;
    expect(old).toMatchObject({ viewingCalcVersion: 1, calcVersion: 2 });
    expect((old?.['lines'] as unknown[]).length).toBe(7);
    expect((await item().GET(req('office', 'GET', `billing-runs/${run}?calcVersion=9`))).status).toBe(404);
  });

  it('確定: 請求書（INV-年月-お客様コード、版1）を作り、対象の報告を BILLING_LOCKED に（除外した報告は承認済みのまま）。確定後の取消・再計算は 409', async () => {
    const run = r['run'] as string;
    const d = (await json(await item().GET(req('office', 'GET', `billing-runs/${run}`)))).data as unknown as Record<string, unknown> & { version: number; warnings: Array<{ id: string }> };
    const rv = await json(await act('admin', run, 'review', { expectedVersion: d.version, reason: '再確認', resolutions: d.warnings.map((w) => ({ warningId: w.id, resolution: 'EXCLUDE' })) }));
    const fin = await act('office', run, 'finalize', { expectedVersion: rv.data?.version as number });
    expect(fin.status).toBe(200);
    const f = (await json(fin)).data as Record<string, unknown>;
    expect(f).toMatchObject({ status: 'FINALIZED', invoiceNo: 'INV-202609-CB1', totalYen: 20290 });
    const invoice = (await t.store.get<InvoiceDoc>(invoicePath(f['invoiceId'] as string))) as InvoiceDoc;
    expect(invoice).toMatchObject({ invoiceNo: 'INV-202609-CB1', revision: 1, status: 'FINALIZED', subtotalYen: 18445, taxYen: 1845, totalYen: 20290, calcVersion: 2, excludedReportIds: [r['w3']] });
    for (const [type, id] of [['WORK', 'w1'], ['WORK', 'w2'], ['WORK', 'w4'], ['DELIVERY', 'd1']] as const) {
      expect((await t.store.get<ReportHeaderDoc>(reportPath(type, r[id] as string)))?.status).toBe('BILLING_LOCKED');
    }
    expect((await t.store.get<ReportHeaderDoc>(reportPath('WORK', r['w3'] as string)))?.status).toBe('APPROVED');
    expect((await t.store.get<ReportHeaderDoc>(reportPath('WORK', r['wOther'] as string)))?.status).toBe('APPROVED');
    // 請求確定済みの報告は取消できない
    const locked = (await t.store.get<ReportHeaderDoc>(reportPath('WORK', r['w1'] as string))) as ReportHeaderDoc;
    expect((await recordTransitionHandlers(field).POST(req('office', 'POST', `records/WORK/${r['w1']}/revoke`, { expectedVersion: locked.version, reason: 'x' }, KEY()))).status).toBe(409);
    expect((await act('office', run, 'void', { expectedVersion: f['version'] as number, reason: '誤り' })).status).toBe(409);
    expect((await act('office', run, 'calculate', { expectedVersion: f['version'] as number })).status).toBe(409);
    const audits = (await auditEventsFor(t.store, 'BILLING_RUN', run)).map((a) => a.action);
    expect(audits).toContain('BILLING_RUN_FINALIZE');
  });

  it('一覧: 期間の新しい順、お客様・状態で絞込（未知 query は 400）', async () => {
    const list = await json(await runs().GET(req('auditor', 'GET', `billing-runs?customerId=${m['customer']}&status=FINALIZED`)));
    const rows = list.data as unknown as Array<Record<string, unknown>>;
    expect(rows.map((x) => x['id'])).toEqual([r['run']]);
    expect(rows[0]).toMatchObject({ invoiceNo: 'INV-202609-CB1' });
    for (const row of rows) expect(schema('BillingRun')(row)).toBe(true);
    expect((await runs().GET(req('office', 'GET', 'billing-runs?sort=x'))).status).toBe(400);
  });
});

describe('CHG-009: 取消と再作成・マスタ変更の影響', () => {
  it('確定前の run は理由付きで取消（VOIDED）でき、同じ期間で作り直せる', async () => {
    const created = await json(await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-10-31' }, KEY())));
    const id = created.data?.id as string;
    expect((await act('office', id, 'void', { expectedVersion: 1 })).status).toBe(422);
    const v = await json(await act('office', id, 'void', { expectedVersion: 1, reason: '期間の誤り' }));
    expect(v.data).toMatchObject({ status: 'VOIDED', voidReason: '期間の誤り' });
    expect((await runs().POST(req('office', 'POST', 'billing-runs', { customerId: m['customer'], periodEnd: '2026-10-31' }, KEY()))).status).toBe(201);
  });

  it('単価ルールの変更 preview は確定前の請求 run の数を返す（確定済みは数えない）', async () => {
    const def = MASTER_DEFS.rates;
    const current = await masters().get('rates', m['rateQ'] as string);
    const input = updateSchema(def).parse({ productId: m['pQ'], unitPrice: '5', validFrom: '2026-01-01', expectedVersion: current.version, reason: '改定' }) as Record<string, unknown>;
    const res = await masters().update('rates', m['rateQ'] as string, input, mctx, true);
    expect(res.kind).toBe('impact');
    if (res.kind === 'impact') expect(res.impact.affectedOpenBillingRunCount).toBe(1);
    expect((await t.store.query(C.billingRuns)).length).toBe(3);
  });
});
