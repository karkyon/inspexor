/**
 * CHG-007 統合試験: 承認ワークフロー（FR-007 / REQ-APR-001 / T-WF-001）と管理ダッシュボード（FR-017 / SCR-10）。
 * HTTP handler（入口ガード込み）→ FieldReportService / DashboardService → DocStore（エミュレータ、無ければ MemoryDocStore）。
 * 帳票作成（worker）の代わりに、確定済みの報告を直接 SUBMITTED にして試す。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { jstToInstant, type RoleCode } from '@inspexor/domain';
import { auditEventsFor, C, createUser, DocIdempotencyRepository, reportPath, StoreAuditRepository, type ReportHeaderDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { writeSchema } from '../masters/schemas';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { handleMeRequest } from '../auth/me-handler';
import { FieldReportService } from '../field/field-report-service';
import { fieldCollectionHandlers, fieldConfirmHandlers, fieldItemHandlers, recordListHandlers, recordTransitionHandlers, type FieldRouteDeps } from '../field/field-handlers';
import { dashboardHandlers, type DashboardRouteDeps } from '../dashboard/dashboard-handlers';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z'); // JST 2026-10-08 12:00
const ON = { APPROVAL_ENABLED: 'true' };
const OFF = {};
let t: TestStore;
let env: Record<string, string> = ON;
let deps: FieldRouteDeps;
let dash: DashboardRouteDeps;
const users: Record<string, string> = {};
const m: Record<string, string> = {};

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const schema = (name: string) => {
  const fn = ajv.getSchema(`o#/components/schemas/${name}`);
  if (!fn) throw new Error(name);
  return fn;
};

async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  const parsed = writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>;
  return (await new MasterService(t.store).create(type, parsed, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW })).id;
}

beforeAll(async () => {
  t = createTestStore('approval');
  for (const [login, role] of [['field-a', 'FIELD'], ['field-b', 'FIELD'], ['office', 'OFFICE'], ['admin', 'ADMIN'], ['auditor', 'AUDITOR']] as const) {
    users[login] = (await createUser(t.store, { loginId: `ap-${login}`, passwordHash: 'x', displayName: login, roles: [role] }, NOW)) as string;
  }
  m['customer'] = await master('customers', { code: 'C1', name: '顧客1', closingDay: 31 });
  m['pA'] = await master('products', { customerId: m['customer'], code: 'P-A', name: '品A', settlementType: 'QUANTITY' });
  m['wtA'] = await master('work-types', { productId: m['pA'], code: 'INSP', name: '検査' });
  m['w1'] = await master('workers', { code: 'W1', name: '作業者1' });
  deps = {
    service: () => new FieldReportService(t.store),
    idempotency: () => new DocIdempotencyRepository(t.store, () => NOW),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined }),
    env: () => env,
  };
  dash = { store: () => t.store, api: deps.api, env: () => env };
}, 60_000);

afterAll(async () => {
  await t?.close();
});

type Who = 'field-a' | 'field-b' | 'office' | 'admin' | 'auditor';
const ROLE: Record<Who, RoleCode> = { 'field-a': 'FIELD', 'field-b': 'FIELD', office: 'OFFICE', admin: 'ADMIN', auditor: 'AUDITOR' };

function req(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const payload = { sessionId: `sess-${who}`, userId: users[who] as string, displayName: who, roles: [ROLE[who]], issuedAt: '2026-10-08T02:55:00.000Z', lastActivityAt: '2026-10-08T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`sess-${who}`, SECRET), 'content-type': 'application/json', ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Json = { data?: Record<string, unknown> & { id: string; version: number; status: string; reportNo: string }; error?: { code: string } };
const json = async (res: Response) => (await res.json()) as Json;
let seq = 0;
const KEY = () => ({ 'idempotency-key': `ap-key-${(seq += 1)}`.padEnd(24, '0') });

/** field-a が作業日報を作って確定し、帳票作成済み（SUBMITTED）にする */
async function submitted(submittedAt: Date = NOW): Promise<{ id: string; version: number; reportNo: string }> {
  const created = await json(
    await fieldCollectionHandlers('WORK', deps).POST(
      req('field-a', 'POST', 'work-reports', {
        workDate: '2026-10-08', reporterId: users['field-a'], customerId: m['customer'], productId: m['pA'], workTypeId: m['wtA'], lotNo: null,
        workerIds: [m['w1']], startAt: jstToInstant('2026-10-08', '09:00'), endAt: jstToInstant('2026-10-08', '10:00'), quantity: 10, defects: [],
      }),
    ),
  );
  const id = created.data?.id as string;
  const c = await fieldConfirmHandlers('WORK', deps).POST(req('field-a', 'POST', `work-reports/${id}/confirm`, { expectedVersion: 1 }, KEY()));
  expect(c.status).toBe(202);
  await t.store.runTransaction(async (tx) => {
    const h = (await tx.get<ReportHeaderDoc>(reportPath('WORK', id))) as ReportHeaderDoc;
    tx.update(reportPath('WORK', id), { status: 'SUBMITTED', version: h.version + 1, submittedAt, documentStatus: 'GENERATED' });
  });
  return { id, version: 3, reportNo: created.data?.reportNo as string };
}

const act = (who: Who, id: string, action: string, body: Record<string, unknown>) =>
  recordTransitionHandlers(deps).POST(req(who, 'POST', `records/WORK/${id}/${action}`, body, KEY()));

describe('CHG-007: 承認ワークフロー（API-013 approve / reject / revoke）', () => {
  it('無効（既定）では approve/reject/revoke は 404、/me の features は無効', async () => {
    env = OFF;
    const r = await submitted();
    expect((await act('office', r.id, 'approve', { expectedVersion: r.version })).status).toBe(404);
    expect((await act('office', r.id, 'reject', { expectedVersion: r.version, reason: 'x' })).status).toBe(404);
    const me = await json(await handleMeRequest(req('office', 'GET', 'me'), { sessionSecret: SECRET, now: () => NOW, env: OFF }));
    expect(me.data?.['features']).toEqual({ approval: false, billing: false, dailyMail: false });
    expect((await dashboardHandlers(dash).GET(req('office', 'GET', 'dashboard'))).status).toBe(404);
    env = ON;
  });

  it('承認: SUBMITTED → APPROVED（コメント任意）。version+1・判断を返す・監査', async () => {
    const r = await submitted();
    const res = await act('office', r.id, 'approve', { expectedVersion: r.version });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ status: 'APPROVED', version: r.version + 1 });
    const d = await json(await fieldItemHandlers('WORK', deps).GET(req('office', 'GET', `work-reports/${r.id}`)));
    expect(d.data?.['decision']).toMatchObject({ action: 'approve', reason: null, actorId: users['office'], revisionNo: 1 });
    expect(schema('WorkReportDetail')(d.data), JSON.stringify(schema('WorkReportDetail').errors)).toBe(true);
    expect((await auditEventsFor(t.store, 'WORK_REPORT', r.id)).filter((a) => a.action === 'WORK_REPORT_APPROVE')).toHaveLength(1);
    // 承認済みは事務所でも直接修正できない（取消してから）
    expect((await act('office', r.id, 'revise', { expectedVersion: r.version + 1, reason: '数量誤り' })).status).toBe(409);
  });

  it('差戻し: 理由必須（空は 422）→ REJECTED。所有者が revise で新しい版の下書きを作れる（他人は 404）', async () => {
    const r = await submitted();
    expect((await act('office', r.id, 'reject', { expectedVersion: r.version })).status).toBe(422);
    expect((await act('office', r.id, 'reject', { expectedVersion: r.version, reason: '   ' })).status).toBe(422);
    const rej = await act('admin', r.id, 'reject', { expectedVersion: r.version, reason: '数量を確認してください' });
    expect(rej.status).toBe(200);
    expect((await json(rej)).data).toMatchObject({ status: 'REJECTED', version: r.version + 1 });
    const list = await json(await recordListHandlers(deps).GET(req('field-a', 'GET', 'records?status=REJECTED')));
    const row = (list.data as unknown as Array<Record<string, unknown>>).find((x) => x['id'] === r.id);
    expect(row?.['decision']).toMatchObject({ action: 'reject', reason: '数量を確認してください' });
    expect(schema('Record')(row), JSON.stringify(schema('Record').errors)).toBe(true);
    // 他人（FIELD）は見えない、所有者でも approve は 403
    expect((await act('field-b', r.id, 'revise', { expectedVersion: r.version + 1, reason: '修正' })).status).toBe(404);
    expect((await act('field-a', r.id, 'approve', { expectedVersion: r.version + 1 })).status).toBe(403);
    const rv = await act('field-a', r.id, 'revise', { expectedVersion: r.version + 1, reason: '数量を修正' });
    expect(rv.status).toBe(200);
    expect((await json(rv)).data).toMatchObject({ status: 'DRAFT', revisionNo: 2 });
    // 新しい版を確定できる（判断の記録は残る）
    const c = await fieldConfirmHandlers('WORK', deps).POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: r.version + 2 }, KEY()));
    expect(c.status).toBe(202);
    const d = await json(await fieldItemHandlers('WORK', deps).GET(req('field-a', 'GET', `work-reports/${r.id}`)));
    expect(d.data).toMatchObject({ status: 'CONFIRMED', revisionNo: 2 });
    expect(d.data?.['decision']).toMatchObject({ action: 'reject', revisionNo: 1 });
  });

  it('所有者は確定済み（差戻し以外）の報告を revise できない（403）', async () => {
    const r = await submitted();
    expect((await act('field-a', r.id, 'revise', { expectedVersion: r.version, reason: '修正' })).status).toBe(403);
  });

  it('取消: APPROVED → REVOKED（理由必須）。SUBMITTED からは 409、取消後は事務所が revise できる', async () => {
    const r = await submitted();
    expect((await act('office', r.id, 'revoke', { expectedVersion: r.version, reason: 'x' })).status).toBe(409);
    expect((await act('office', r.id, 'approve', { expectedVersion: r.version })).status).toBe(200);
    expect((await act('office', r.id, 'revoke', { expectedVersion: r.version + 1 })).status).toBe(422);
    const rv = await act('office', r.id, 'revoke', { expectedVersion: r.version + 1, reason: '請求前に数量訂正' });
    expect(rv.status).toBe(200);
    expect((await json(rv)).data).toMatchObject({ status: 'REVOKED' });
    expect((await act('office', r.id, 'revise', { expectedVersion: r.version + 2, reason: '数量訂正' })).status).toBe(200);
  });

  it('version 不一致は 409、二重承認は 409、AUDITOR・FIELD（他人）は承認できない', async () => {
    const r = await submitted();
    expect((await act('office', r.id, 'approve', { expectedVersion: r.version - 1 })).status).toBe(409);
    expect((await act('auditor', r.id, 'approve', { expectedVersion: r.version })).status).toBe(403);
    expect((await act('field-b', r.id, 'approve', { expectedVersion: r.version })).status).toBe(403);
    expect((await act('office', r.id, 'approve', { expectedVersion: r.version })).status).toBe(200);
    expect((await act('office', r.id, 'approve', { expectedVersion: r.version + 1 })).status).toBe(409);
  });

  it('同じ Idempotency-Key の再送は同じ応答（二重承認しない）', async () => {
    const r = await submitted();
    const key = { 'idempotency-key': 'ap-idem-approve-0000000000' };
    const a = await recordTransitionHandlers(deps).POST(req('office', 'POST', `records/WORK/${r.id}/approve`, { expectedVersion: r.version }, key));
    const b = await recordTransitionHandlers(deps).POST(req('office', 'POST', `records/WORK/${r.id}/approve`, { expectedVersion: r.version }, key));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect((await auditEventsFor(t.store, 'WORK_REPORT', r.id)).filter((x) => x.action === 'WORK_REPORT_APPROVE')).toHaveLength(1);
  });
});

describe('CHG-007: 管理ダッシュボード（API-029、SCR-10）', () => {
  it('承認待ち・24時間超過・本日の実績・要対応・直近7日を返す。FIELD は 403、schema 準拠', async () => {
    const before = await json(await dashboardHandlers(dash).GET(req('office', 'GET', 'dashboard')));
    const k0 = before.data?.['kpis'] as Record<string, number>;
    const old = await submitted(new Date(NOW.getTime() - 30 * 3600_000));
    const rj = await submitted();
    expect((await act('office', rj.id, 'reject', { expectedVersion: rj.version, reason: '再確認' })).status).toBe(200);
    const res = await dashboardHandlers(dash).GET(req('auditor', 'GET', 'dashboard'));
    expect(res.status).toBe(200);
    const d = (await json(res)).data as Record<string, unknown>;
    expect(schema('Dashboard')(d), JSON.stringify(schema('Dashboard').errors)).toBe(true);
    const k = d['kpis'] as Record<string, number>;
    expect(k['pendingApproval']).toBe((k0['pendingApproval'] ?? 0) + 1);
    expect(k['pendingOver24h']).toBe((k0['pendingOver24h'] ?? 0) + 1);
    expect(k['todayWorkConfirmed']).toBeGreaterThanOrEqual(2);
    expect(d['today']).toBe('2026-10-08');
    const daily = d['daily'] as Array<{ date: string; work: number }>;
    expect(daily).toHaveLength(7);
    expect(daily[6]).toMatchObject({ date: '2026-10-08' });
    expect(daily[0]?.date).toBe('2026-10-02');
    const att = d['attention'] as Array<{ kind: string; reportId: string }>;
    expect(att.some((a) => a.kind === 'APPROVAL_OVERDUE' && a.reportId === old.id)).toBe(true);
    expect(att.some((a) => a.kind === 'REJECTED' && a.reportId === rj.id)).toBe(true);
    expect((await dashboardHandlers(dash).GET(req('field-a', 'GET', 'dashboard'))).status).toBe(403);
    expect((await dashboardHandlers(dash).GET(req('office', 'GET', 'dashboard?x=1'))).status).toBe(400);
  });

  it('帳票の処理失敗（最新の帳票のみ）を数え、要対応に出す', async () => {
    const r = await submitted();
    const jobId = '0b9f2d3e-1c4a-4e5f-8a6b-7c8d9e0f1a2b';
    await t.store.runTransaction(async (tx) => {
      tx.set(`${C.documents}/${jobId}`, {
        documentType: 'DAILY_REPORT', sourceType: 'WORK_REVISION', reportType: 'WORK', reportId: r.id, revisionId: 'x', revisionNo: 1, templateVersion: 'DAILY_REPORT_V2',
        status: 'FAILED_FINAL', idempotencyKey: 'x', fileId: null, attempts: 5, errorCode: 'DEPENDENCY_UNAVAILABLE', createdAt: NOW, updatedAt: NOW,
      });
      tx.update(reportPath('WORK', r.id), { documentId: jobId, documentStatus: 'FAILED_FINAL' });
    });
    const d = (await json(await dashboardHandlers(dash).GET(req('office', 'GET', 'dashboard')))).data as Record<string, unknown>;
    expect((d['kpis'] as Record<string, number>)['failedDocuments']).toBeGreaterThanOrEqual(1);
    expect((d['attention'] as Array<{ kind: string; reportId: string }>).some((a) => a.kind === 'DOCUMENT_FAILED' && a.reportId === r.id)).toBe(true);
  });
});
