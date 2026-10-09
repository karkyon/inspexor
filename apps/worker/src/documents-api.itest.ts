/**
 * G4 統合試験（web 側。worker の runOnce と組合わせるため worker パッケージに置く）（API-024 getDocument / API-025 documentAction / 署名付き URL / FR-018・SEC-013）。
 * web の handler（入口ガード込み）と worker の runOnce（試験用 renderer・sender）を同じ fresh DB で通す。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RoleCode } from '@inspexor/domain';
import { jstToInstant } from '@inspexor/domain';
import { createFreshDatabase, insertUser, type FreshDatabase } from '../../web/lib/testing/fresh-db';
import { PgAuditRepository } from '../../web/lib/db/pg-audit-repository';
import { issueSessionToken } from '../../web/lib/auth/session-token';
import { SESSION_COOKIE_NAME } from '../../web/lib/auth/session-cookie';
import { issueCsrfToken } from '../../web/lib/security/csrf';
import { FieldReportService } from '../../web/lib/field/field-report-service';
import { fieldItemHandlers, recordListHandlers, type FieldRouteDeps } from '../../web/lib/field/field-handlers';
import { DocumentService } from '../../web/lib/documents/document-service';
import { documentActionHandlers, documentItemHandlers, type DocumentRouteDeps } from '../../web/lib/documents/document-handlers';
import { runOnce } from './worker';
import { LocalFsStorage } from './adapters/local-fs-storage';
import type { MailMessage, MailSender, PdfRenderer } from './ports';

const SECRET = 'd'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z');
let db: FreshDatabase;
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

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.pool.query(sql, params)).rows[0] as T;
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

const api = () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new PgAuditRepository(db.pool), logError: () => undefined });
const docDeps = (): DocumentRouteDeps => ({ service: () => new DocumentService(db.pool, SECRET, true), pool: () => db.pool, api });
const fieldDeps = (): FieldRouteDeps => ({ service: () => new FieldReportService(db.pool), pool: () => db.pool, api });
const worker = () => runOnce({ pool: db.pool, storage: new LocalFsStorage(storage), pdf: renderer, sender, now: () => new Date(), dailyMailEnabled: true });
type Json = { data?: Record<string, unknown>; error?: { code: string; fields?: Array<{ path: string }> } };
const json = async (r: Response) => (await r.json()) as Json;
const ctx = () => ({ actor: { userId: users['field'] as string, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000002', now: NOW });
const KEY = (s: string) => ({ 'idempotency-key': `doc-itest-${s}`.padEnd(20, '0') });

let work: { id: string; reportNo: string };
let delivery: { id: string };
let workDocId: string;

beforeAll(async () => {
  db = await createFreshDatabase('documents');
  storage = await mkdtemp(join(tmpdir(), 'inspexor-doc-'));
  process.env['STORAGE_DIR'] = storage;
  process.env['AUTH_SECRET'] = SECRET;
  const url = new URL(process.env['ITEST_DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  process.env['DATABASE_URL'] = url.toString();
  for (const [k, role] of [['field', 'FIELD'], ['field2', 'FIELD'], ['office', 'OFFICE'], ['auditor', 'AUDITOR']] as const) {
    users[k] = await insertUser(db.pool, `doc-${k}`);
    await db.pool.query('INSERT INTO app.user_roles VALUES ($1, $2)', [users[k], role]);
  }
  m['c'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C1','顧客',31) RETURNING id`)).id;
  m['p'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'P1','品1','QUANTITY') RETURNING id`, [m['c']])).id;
  m['wt'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','検査') RETURNING id`, [m['p']])).id;
  m['w'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W1','作業者') RETURNING id`)).id;
  const k = (await one(`INSERT INTO app.customer_contacts(customer_id,code,name,email,send_daily) VALUES ($1,'K1','担当','k1@example.com',true) RETURNING id`, [m['c']])).id;
  await db.pool.query(`INSERT INTO app.product_contacts VALUES ($1,$2,'DAILY')`, [m['p'], k]);
  const svc = new FieldReportService(db.pool);
  const w = await svc.createWork(
    { workDate: '2026-10-08', reporterId: users['field'] as string, customerId: m['c'] as string, productId: m['p'] as string, workTypeId: m['wt'] as string, lotNo: null, workerIds: [m['w'] as string], startAt: jstToInstant('2026-10-08', '09:00'), endAt: jstToInstant('2026-10-08', '10:00'), quantity: 10, defects: [] },
    ctx(),
  );
  await svc.confirm('WORK', w.id, 1, ctx());
  work = { id: w.id, reportNo: w.reportNo };
  const d = await svc.createDelivery({ deliveryDate: '2026-10-08', driverId: m['w'] as string, customerId: m['c'] as string, items: [{ productId: m['p'] as string, quantity: 1 }] }, ctx());
  await svc.confirm('DELIVERY', d.id, 1, ctx());
  delivery = { id: d.id };
}, 120_000);

afterAll(async () => {
  // 配信 route が使った web の共有 pool を先に閉じる（DROP DATABASE WITH FORCE 前）
  const shared = (globalThis as { inspexorPgPool?: { end(): Promise<void> } }).inspexorPgPool;
  await shared?.end();
  await db?.drop();
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
  const version = async () => (await one<{ version: number }>('SELECT version FROM app.work_reports WHERE id=$1', [work.id])).version;

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
    expect(Number((await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE event_type='MailRequested'`)).n)).toBe(1);
    const audit = await one<{ reason: string }>(`SELECT reason FROM app.audit_events WHERE action='DOCUMENT_SEND_REQUEST' AND target_id=$1`, [workDocId]);
    expect(audit.reason).toBe('お客様から再送依頼');
    await worker();
    const mails = await db.pool.query<{ send_revision: number; status: string }>('SELECT send_revision, status::text AS status FROM app.mail_jobs WHERE document_job_id=$1 ORDER BY send_revision', [workDocId]);
    expect(mails.rows).toEqual([{ send_revision: 1, status: 'SENT' }, { send_revision: 2, status: 'SENT' }]);
    expect(sent).toHaveLength(2);
  });

  it('retry: 最終失敗が無ければ 409。regenerate: 新しい帳票 job（旧版保持、実績の状態・version は不変、メールは送らない）', async () => {
    const h = documentActionHandlers(docDeps());
    const v = await version();
    expect((await h.POST(req('office', 'POST', `documents/${workDocId}/retry`, { expectedVersion: v, reason: '再実行' }, KEY('r1')))).status).toBe(409);
    const regen = await h.POST(req('office', 'POST', `documents/${workDocId}/regenerate`, { expectedVersion: v, reason: '帳票の再作成' }, KEY('g1')));
    expect(regen.status).toBe(202);
    await worker();
    const jobs = await db.pool.query<{ status: string; idempotency_key: string }>(
      `SELECT d.status::text AS status, d.idempotency_key FROM app.document_jobs d JOIN app.work_report_revisions r ON r.id=d.source_id WHERE r.report_id=$1 ORDER BY d.created_at`,
      [work.id],
    );
    expect(jobs.rows.map((j) => j.status)).toEqual(['GENERATED', 'GENERATED']);
    expect(jobs.rows[1]?.idempotency_key).toMatch(/:regenerate:/);
    expect(await one('SELECT status::text AS status, version FROM app.work_reports WHERE id=$1', [work.id])).toEqual({ status: 'SUBMITTED', version: v });
    expect(sent).toHaveLength(2);
    const latest = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data;
    expect(latest?.['documentId']).not.toBe(workDocId);
  });

  it('CHG-004: メール無効（既定）では send は未定義の操作（404）、理由があっても副作用なし', async () => {
    const off = (): DocumentRouteDeps => ({ service: () => new DocumentService(db.pool, SECRET), pool: () => db.pool, api });
    const before = Number((await one<{ n: string }>('SELECT count(*) n FROM app.outbox_events')).n);
    const v = Number((await one<{ version: number }>('SELECT version FROM app.work_reports WHERE id=$1', [work.id])).version);
    const r = await documentActionHandlers(off()).POST(req('office', 'POST', `documents/${workDocId}/send`, { expectedVersion: v, reason: '送信' }, KEY('off')));
    expect(r.status).toBe(404);
    expect((await json(r)).error?.fields?.[0]?.path).toBe('/action');
    expect(Number((await one<{ n: string }>('SELECT count(*) n FROM app.outbox_events')).n)).toBe(before);
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
    await db.pool.query(`UPDATE app.customer_contacts SET send_daily=false`);
    const v = await version();
    const h = documentActionHandlers(docDeps());
    const docNow = (await json(await fieldItemHandlers('WORK', fieldDeps()).GET(req('field', 'GET', `work-reports/${work.id}`)))).data?.['documentId'] as string;
    expect((await h.POST(req('office', 'POST', `documents/${docNow}/send`, { expectedVersion: v, reason: '送信' }, KEY('s0')))).status).toBe(202);
    await worker();
    expect(await one('SELECT status::text AS status, error_code FROM app.mail_jobs WHERE document_job_id=$1 ORDER BY created_at DESC LIMIT 1', [docNow])).toEqual({ status: 'FAILED_FINAL', error_code: 'RECIPIENT_EMPTY' });
    await db.pool.query(`UPDATE app.customer_contacts SET send_daily=true`);
    expect((await h.POST(req('office', 'POST', `documents/${docNow}/retry`, { expectedVersion: v, reason: '宛先を修正したため' }, KEY('rt')))).status).toBe(202);
    await worker();
    expect(await one('SELECT status::text AS status FROM app.mail_jobs WHERE document_job_id=$1 ORDER BY created_at DESC LIMIT 1', [docNow])).toEqual({ status: 'SENT' });
  });
});
