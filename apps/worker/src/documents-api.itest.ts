/**
 * G4 統合試験（web 側。worker の runOnce と組合わせるため worker パッケージに置く）（API-024 getDocument / API-025 documentAction / 署名付き URL / FR-018・SEC-013）。
 * web の handler（入口ガード込み）と worker の runOnce（試験用 renderer・sender）を同じ DocStore で通す。
 * CHG-006: Firestore（エミュレータ、無ければ MemoryDocStore）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RoleCode } from '@inspexor/domain';
import { jstToInstant } from '@inspexor/domain';
import {
  auditEventsFor,
  C,
  createUser,
  DocIdempotencyRepository,
  LocalFsStorage,
  StoreAuditRepository,
  type DocumentJobDoc,
  type MailJobDoc,
  type OutboxDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { setDocStoreForTest } from '../../web/lib/db/docstore';
import { MasterService } from '../../web/lib/masters/master-service';
import { MASTER_DEFS, type MasterType } from '../../web/lib/masters/definitions';
import { writeSchema } from '../../web/lib/masters/schemas';
import { issueSessionToken } from '../../web/lib/auth/session-token';
import { SESSION_COOKIE_NAME } from '../../web/lib/auth/session-cookie';
import { issueCsrfToken } from '../../web/lib/security/csrf';
import { FieldReportService } from '../../web/lib/field/field-report-service';
import { fieldItemHandlers, recordListHandlers, type FieldRouteDeps } from '../../web/lib/field/field-handlers';
import { DocumentService } from '../../web/lib/documents/document-service';
import { documentActionHandlers, documentItemHandlers, type DocumentRouteDeps } from '../../web/lib/documents/document-handlers';
import { runOnce } from './worker';
import type { MailMessage, MailSender, PdfRenderer } from './ports';

const SECRET = 'd'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z');
let t: TestStore;
let storage: string;
const users: Record<string, string> = {};
const m: Record<string, string> = {};
const sent: MailMessage[] = [];

const renderer: PdfRenderer = {
  async render(html: string) {
    return Buffer.from(`%PDF-1.7\n${createHash('sha256').update(html).digest('hex')}\n%%EOF`);
  },
  async close() {},
};
const sender: MailSender = {
  async findSent(id) {
    return sent.find((s) => s.messageId === id) ? `id-${id}` : null;
  },
  async send(msg) {
    sent.push(msg);
    return `id-${msg.messageId}`;
  },
};

async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  const parsed = writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>;
  return (await new MasterService(t.store).create(type, parsed, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW })).id;
}

async function mailJobs(documentJobId: string): Promise<Array<MailJobDoc & { id: string }>> {
  return (await t.store.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'documentJobId', op: '==', value: documentJobId }] }))
    .map((r) => ({ ...r.data, id: r.id }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sendRevision - b.sendRevision);
}

async function setSendDaily(value: boolean): Promise<void> {
  const rows = await t.store.query(C.customerContacts);
  await t.store.runTransaction(async (tx) => {
    for (const r of rows) tx.update(r.path, { sendDaily: value });
  });
}

type Who = 'field' | 'field2' | 'office' | 'auditor';
const ROLE: Record<Who, RoleCode> = { field: 'FIELD', field2: 'FIELD', office: 'OFFICE', auditor: 'AUDITOR' };

function req(who: Who, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const payload = { sessionId: `s-${who}`, userId: users[who] as string, displayName: who, roles: [ROLE[who]], issuedAt: '2026-10-08T02:55:00.000Z', lastActivityAt: '2026-10-08T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`s-${who}`, SECRET), 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const api = () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store), logError: () => undefined });
const idem = () => new DocIdempotencyRepository(t.store, () => NOW);
const docDeps = (): DocumentRouteDeps => ({ service: () => new DocumentService(t.store, SECRET, true), idempotency: idem, api });
const fieldDeps = (): FieldRouteDeps => ({ service: () => new FieldReportService(t.store), idempotency: idem, api });
const worker = () => runOnce({ store: t.store, storage: new LocalFsStorage(storage), pdf: renderer, sender, now: () => new Date(), dailyMailEnabled: true });
type Json = { data?: Record<string, unknown>; error?: { code: string; fields?: Array<{ path: string }> } };
const json = async (r: Response) => (await r.json()) as Json;
const ctx = () => ({ actor: { userId: users['field'] as string, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000002', now: NOW });
const KEY = (s: string) => ({ 'idempotency-key': `doc-itest-${s}`.padEnd(20, '0') });

let work: { id: string; reportNo: string };
let delivery: { id: string };
let workDocId: string;

beforeAll(async () => {
  t = createTestStore('documents');
  storage = await mkdtemp(join(tmpdir(), 'inspexor-doc-'));
  process.env['STORAGE_DIR'] = storage;
  delete process.env['STORAGE_BUCKET'];
  process.env['AUTH_SECRET'] = SECRET;
  // 配信 route（app/api/files）が使う共有 DocStore を試験用に差し替える
  setDocStoreForTest(t.store);
  for (const [k, role] of [['field', 'FIELD'], ['field2', 'FIELD'], ['office', 'OFFICE'], ['auditor', 'AUDITOR']] as const) {
    users[k] = (await createUser(t.store, { loginId: `doc-${k}`, passwordHash: 'x', displayName: k, roles: [role] }, NOW)) as string;
  }
  m['c'] = await master('customers', { code: 'C1', name: '顧客', closingDay: 31 });
  m['p'] = await master('products', { customerId: m['c'], code: 'P1', name: '品1', settlementType: 'QUANTITY' });
  m['wt'] = await master('work-types', { productId: m['p'], code: 'INSP', name: '検査' });
  m['w'] = await master('workers', { code: 'W1', name: '作業者' });
  await master('contacts', { customerId: m['c'], code: 'K1', name: '担当', email: 'k1@example.com', sendDaily: true, dailyProductIds: [m['p']] });
  const svc = new FieldReportService(t.store);
  const w = await svc.createWork(
    { workDate: '2026-10-08', reporterId: users['field'] as string, customerId: m['c'] as string, productId: m['p'] as string, workTypeId: m['wt'] as string, lotNo: null, workerIds: [m['w'] as string], startAt: jstToInstant('2026-10-08', '09:00'), endAt: jstToInstant('2026-10-08', '10:00'), quantity: 10, defects: [], workLocationId: null, vehicleId: null, remarks: null },
    ctx(),
  );
  await svc.confirm('WORK', w.id, 1, ctx());
  work = { id: w.id, reportNo: w.reportNo };
  const d = await svc.createDelivery({ deliveryDate: '2026-10-08', driverId: m['w'] as string, customerId: m['c'] as string, items: [{ productId: m['p'] as string, quantity: 1 }], vehicleId: null, tripCount: 1, deliveryFeeYen: null }, ctx());
  await svc.confirm('DELIVERY', d.id, 1, ctx());
  delivery = { id: d.id };
}, 120_000);

afterAll(async () => {
  setDocStoreForTest(undefined);
  await t?.close();
});

describe('G4: 実績の documentStatus / documentId（CHG-003）', () => {
  it('worker 実行前は QUEUED 前（null）、実行後は GENERATED・SUBMITTED', async () => {
    const before = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data;
    expect(before).toMatchObject({ status: 'CONFIRMED', documentStatus: null, documentId: null });
    await worker();
    const after = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data;
    expect(after).toMatchObject({ status: 'SUBMITTED', documentStatus: 'GENERATED' });
    workDocId = after?.['documentId'] as string;
    expect(workDocId).toMatch(/^[0-9a-f-]{36}$/);
    const list = (await (await recordListHandlers(fieldDeps()).GET(req('field', 'GET', 'records'))).json()) as { data: Array<{ id: string; documentStatus: string }> };
    expect(list.data.find((r) => r.id === work.id)?.documentStatus).toBe('GENERATED');
    expect(sent).toHaveLength(1);
  });
});

describe('G4: API-024 getDocument（scope・10分署名 URL）', () => {
  it('所有者・OFFICE・AUDITOR は参照可、他の FIELD は 404（存在秘匿）', async () => {
    for (const who of ['field', 'office', 'auditor'] as const) {
      const r = await documentItemHandlers(docDeps()).GET(req(who, 'GET', `documents/${workDocId}`));
      expect(r.status, who).toBe(200);
    }
    expect((await documentItemHandlers(docDeps()).GET(req('field2', 'GET', `documents/${workDocId}`))).status).toBe(404);
    expect((await documentItemHandlers(docDeps()).GET(req('office', 'GET', 'documents/not-uuid'))).status).toBe(404);
  });

  it('応答: file メタデータ・署名 URL（10分）・メール履歴（宛先アドレスは返さない）', async () => {
    const d = (await json(await documentItemHandlers(docDeps()).GET(req('field', 'GET', `documents/${workDocId}`)))).data as Record<string, unknown>;
    expect(d).toMatchObject({ status: 'GENERATED', templateVersion: 'DAILY_REPORT_V2', source: { type: 'WORK', reportNo: work.reportNo, revisionNo: 1 } });
    expect((d['file'] as { fileName: string }).fileName).toBe(`日報_2026-10-08_C1_${work.reportNo}_r1.pdf`);
    expect(d['signedUrl']).toMatch(/^\/api\/files\/[0-9a-f-]{36}\?exp=\d+&sig=/);
    expect(d['signedUrlExpiresAt']).toBe('2026-10-08T03:10:00.000Z');
    expect(d['mails']).toEqual([expect.objectContaining({ status: 'SENT', sendRevision: 1, recipientCount: 1 })]);
    expect(JSON.stringify(d)).not.toContain('k1@example.com');
  });

  it('配信 route: 正しい署名は PDF、改ざん・期限切れは 403', async () => {
    const { GET } = await import('../../web/app/api/files/[id]/route');
    const d = (await json(await documentItemHandlers(docDeps()).GET(req('field', 'GET', `documents/${workDocId}`)))).data as Record<string, unknown>;
    const fileId = String(d['signedUrl']).split('/')[3]?.split('?')[0] as string;
    // route は現在時刻で検証するため、現在時刻で署名し直した URL を使う
    const { signFileUrl } = await import('../../web/lib/documents/signed-url');
    const fresh = signFileUrl(fileId, new Date(), SECRET).url;
    const ok = await GET(new Request(`https://example.com${fresh}`), { params: { id: fileId } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('content-disposition')).toContain(encodeURIComponent(`日報_2026-10-08_C1_${work.reportNo}_r1.pdf`));
    expect(ok.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    // 提案書: プレビュー（ブラウザ内表示）。disposition は署名対象外だが署名は引き続き必須
    const inline = await GET(new Request(`https://example.com${fresh}&disposition=inline`), { params: { id: fileId } });
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-disposition')?.startsWith('inline;')).toBe(true);
    expect((await GET(new Request(`https://example.com${fresh.replace(/sig=./, 'sig=A')}&disposition=inline`), { params: { id: fileId } })).status).toBe(403);
    const tampered = fresh.replace(/sig=./, 'sig=A');
    expect((await GET(new Request(`https://example.com${tampered}`), { params: { id: fileId } })).status).toBe(403);
    const expired = signFileUrl(fileId, new Date(Date.now() - 11 * 60_000), SECRET).url;
    expect((await GET(new Request(`https://example.com${expired}`), { params: { id: fileId } })).status).toBe(403);
  });
});

describe('G4: API-025 documentAction（理由必須・冪等・状態）', () => {
  const version = async () => ((await t.store.get<ReportHeaderDoc>(`${C.workReports}/${work.id}`)) as ReportHeaderDoc).version;

  it('FIELD は 403、Idempotency-Key 欠落は 422、理由なしは 422、古い version は 409', async () => {
    const h = documentActionHandlers(docDeps());
    expect((await h.POST(req('field', 'POST', `documents/${workDocId}/send`, { expectedVersion: await version(), reason: 'x' }, KEY('a')))).status).toBe(403);
    expect((await h.POST(req('office', 'POST', `documents/${workDocId}/send`, { expectedVersion: await version(), reason: 'x' }))).status).toBe(422);
    const noReason = await h.POST(req('office', 'POST', `documents/${workDocId}/send`, { expectedVersion: await version() }, KEY('b')));
    expect(noReason.status).toBe(422);
    expect((await json(noReason)).error?.fields?.[0]?.path).toBe('/reason');
    expect((await h.POST(req('office', 'POST', `documents/${workDocId}/send`, { expectedVersion: 1, reason: 'x' }, KEY('c')))).status).toBe(409);
    expect((await h.POST(req('office', 'POST', `documents/${workDocId}/unknown`, { expectedVersion: 1, reason: 'x' }, KEY('d')))).status).toBe(404);
  });

  it('send: 202 → 同じ key は再生（副作用1回）→ worker で再送（send_revision 2）', async () => {
    const h = documentActionHandlers(docDeps());
    const body = { expectedVersion: await version(), reason: 'お客様から再送依頼' };
    const r1 = await h.POST(req('office', 'POST', `documents/${workDocId}/send`, body, KEY('send1')));
    expect(r1.status).toBe(202);
    const r2 = await h.POST(req('office', 'POST', `documents/${workDocId}/send`, body, KEY('send1')));
    expect(r2.headers.get('idempotent-replayed')).toBe('true');
    expect((await t.store.query<OutboxDoc>(C.outbox, { where: [{ field: 'type', op: '==', value: 'MailRequested' }] })).length).toBe(1);
    const audit = (await auditEventsFor(t.store, 'DOCUMENT_JOB', workDocId)).find((a) => a.action === 'DOCUMENT_SEND_REQUEST');
    expect(audit?.reason).toBe('お客様から再送依頼');
    await worker();
    const mails = (await mailJobs(workDocId)).sort((a, b) => a.sendRevision - b.sendRevision);
    expect(mails.map((x) => ({ send_revision: x.sendRevision, status: x.status }))).toEqual([{ send_revision: 1, status: 'SENT' }, { send_revision: 2, status: 'SENT' }]);
    expect(sent).toHaveLength(2);
  });

  it('retry: 最終失敗が無ければ 409。regenerate: 新しい帳票 job（旧版保持、実績の状態・version は不変、メールは送らない）', async () => {
    const h = documentActionHandlers(docDeps());
    const v = await version();
    expect((await h.POST(req('office', 'POST', `documents/${workDocId}/retry`, { expectedVersion: v, reason: '再実行' }, KEY('r1')))).status).toBe(409);
    const regen = await h.POST(req('office', 'POST', `documents/${workDocId}/regenerate`, { expectedVersion: v, reason: '帳票の再作成' }, KEY('g1')));
    expect(regen.status).toBe(202);
    await worker();
    const jobs = (await t.store.query<DocumentJobDoc>(C.documents, { where: [{ field: 'reportId', op: '==', value: work.id }] }))
      .map((r) => r.data)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(jobs.map((j) => j.status)).toEqual(['GENERATED', 'GENERATED']);
    expect(jobs[1]?.idempotencyKey).toMatch(/:regenerate:/);
    const hd = (await t.store.get<ReportHeaderDoc>(`${C.workReports}/${work.id}`)) as ReportHeaderDoc;
    expect({ status: hd.status, version: hd.version }).toEqual({ status: 'SUBMITTED', version: v });
    expect(sent).toHaveLength(2);
    const latest = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data;
    expect(latest?.['documentId']).not.toBe(workDocId);
  });

  it('CHG-004: メール無効（既定）では send は未定義の操作（404）、理由があっても副作用なし', async () => {
    const off = (): DocumentRouteDeps => ({ service: () => new DocumentService(t.store, SECRET), idempotency: idem, api });
    const before = await t.store.count(C.outbox);
    const v = await version();
    const r = await documentActionHandlers(off()).POST(req('office', 'POST', `documents/${workDocId}/send`, { expectedVersion: v, reason: '送信' }, KEY('off')));
    expect(r.status).toBe(404);
    expect((await json(r)).error?.fields?.[0]?.path).toBe('/action');
    expect(await t.store.count(C.outbox)).toBe(before);
  });

  it('運搬の帳票は send 不可（CHG-003: メール送信なし）', async () => {
    const d = (await json(await fieldItemHandlers('DELIVERY', fieldDeps()).GET(req('field', 'GET', `delivery-reports/${delivery.id}`)))).data as Record<string, unknown>;
    expect(d['documentStatus']).toBe('GENERATED');
    const v = d['version'] as number;
    const r = await documentActionHandlers(docDeps()).POST(req('office', 'POST', `documents/${String(d['documentId'])}/send`, { expectedVersion: v, reason: '送信' }, KEY('dl')));
    expect(r.status).toBe(409);
    expect((await json(r)).error?.code).toBe('STATE_CONFLICT');
  });

  it('retry: 宛先0件で FAILED_FINAL のメールは再実行できる（新 mail job）', async () => {
    await setSendDaily(false);
    const v = await version();
    const h = documentActionHandlers(docDeps());
    const docNow = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data?.['documentId'] as string;
    expect((await h.POST(req('office', 'POST', `documents/${docNow}/send`, { expectedVersion: v, reason: '送信' }, KEY('s0')))).status).toBe(202);
    await worker();
    const failed = (await mailJobs(docNow)).at(-1);
    expect({ status: failed?.status, error_code: failed?.errorCode }).toEqual({ status: 'FAILED_FINAL', error_code: 'RECIPIENT_EMPTY' });
    await setSendDaily(true);
    expect((await h.POST(req('office', 'POST', `documents/${docNow}/retry`, { expectedVersion: v, reason: '宛先を修正したため' }, KEY('rt')))).status).toBe(202);
    await worker();
    expect((await mailJobs(docNow)).at(-1)?.status).toBe('SENT');
  });
});
