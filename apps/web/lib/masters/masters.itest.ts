/**
 * G2 統合試験（T-MST-001 系 / REQ-MST-001 / CHG-001）。実PostgreSQL 16 の fresh DB（schema.sql＋migration）に対し、
 * HTTP handler（入口ガード込み）→ MasterService → DB を通しで検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { RoleCode } from '@inspexor/domain';
import { createFreshDatabase, insertUser, findSpecFile, type FreshDatabase } from '../testing/fresh-db';
import '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { MasterService } from './master-service';
import { masterCollectionHandlers, masterItemHandlers, type MasterRouteDeps } from './master-handlers';

const SECRET = 'm'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z'); // JST 2026-10-08 12:00
let db: FreshDatabase;
let adminId: string;
let deps: MasterRouteDeps;
let collection: ReturnType<typeof masterCollectionHandlers>;
let item: ReturnType<typeof masterItemHandlers>;

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const masterRecordSchema = ajv.getSchema('o#/components/schemas/MasterRecord');
const impactSchema = ajv.getSchema('o#/components/schemas/MasterImpact');

beforeAll(async () => {
  db = await createFreshDatabase('masters');
  adminId = await insertUser(db.pool, 'itest-admin');
  deps = {
    service: () => new MasterService(db.pool),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new PgAuditRepository(db.pool), logError: () => undefined }),
  };
  collection = masterCollectionHandlers(deps);
  item = masterItemHandlers(deps);
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

function req(method: string, path: string, body?: unknown, roles: RoleCode[] = ['ADMIN']): Request {
  const payload = {
    sessionId: 'sess-m',
    userId: adminId,
    displayName: '管理者',
    roles,
    issuedAt: '2026-10-08T02:55:00.000Z',
    lastActivityAt: '2026-10-08T02:55:00.000Z',
  };
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`,
    'x-csrf-token': issueCsrfToken('sess-m', SECRET),
    'content-type': 'application/json',
  };
  return new Request(`https://example.com/api/v1/masters/${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Json = { data?: Record<string, unknown> & { id: string; version: number }; meta?: Record<string, number>; error?: { code: string; fields?: Array<{ path: string; code: string }>; currentVersion?: number; changedFields?: string[] } };
const json = async (res: Response) => (await res.json()) as Json;

async function create(type: string, body: Record<string, unknown>) {
  const res = await collection.POST(req('POST', type, body));
  const j = await json(res);
  if (res.status !== 201) throw new Error(`${type} create failed ${res.status} ${JSON.stringify(j)}`);
  return j.data as NonNullable<Json['data']>;
}

describe('T-MST-001 正常: 作成・取得・一覧・監査', () => {
  it('顧客を作成: 201、version=1、code は NFKC 正規化、MasterRecord schema 適合、audit記録', async () => {
    const res = await collection.POST(req('POST', 'customers', { code: 'ＣＵ００１', name: '  テスト顧客  ', closingDay: 25 }));
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data).toMatchObject({ code: 'CU001', name: 'テスト顧客', closingDay: 25, version: 1, active: true });
    expect(masterRecordSchema?.(data)).toBe(true);
    const audit = await db.pool.query(`SELECT action, target_type, correlation_id FROM app.audit_events WHERE target_id = $1`, [data?.id]);
    expect(audit.rows[0]).toMatchObject({ action: 'MASTER_CREATE', target_type: 'MASTER:customers' });
    expect(audit.rows[0].correlation_id).toBe(res.headers.get('x-correlation-id'));
  });

  it('一覧: {data, meta}、page/pageSize、未知queryは400', async () => {
    const ok = await collection.GET(req('GET', 'customers?page=1&pageSize=10'));
    const j = await json(ok);
    expect(ok.status).toBe(200);
    expect(j.meta).toMatchObject({ page: 1, pageSize: 10 });
    expect((j.meta?.total ?? 0) >= 1).toBe(true);
    expect((await collection.GET(req('GET', 'customers?sort=code'))).status).toBe(400);
    expect((await collection.GET(req('GET', 'customers?pageSize=101'))).status).toBe(400);
  });

  it('取得: 存在しない id / 不正 id / 未定義type は 404', async () => {
    expect((await item.GET(req('GET', 'customers/11111111-1111-4111-8111-111111111111'))).status).toBe(404);
    expect((await item.GET(req('GET', 'customers/not-uuid'))).status).toBe(404);
    expect((await collection.GET(req('GET', 'unknown-type'))).status).toBe(404);
  });
});

describe('T-MST-001 境界・異常: 一意・未知field・参照保護', () => {
  it('同一code は 422 /code duplicate', async () => {
    await create('workers', { code: 'W-DUP', name: '作業者' });
    const res = await collection.POST(req('POST', 'workers', { code: 'W-DUP', name: '別人' }));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/code', code: 'duplicate' });
  });

  it('未知field は 422（Zod strict）', async () => {
    expect((await collection.POST(req('POST', 'workers', { code: 'W2', name: 'n', extra: 1 }))).status).toBe(422);
  });

  it('存在しない親は 422 not_found、無効化された親は 422 MASTER_INACTIVE', async () => {
    const missing = await collection.POST(req('POST', 'products', { customerId: '11111111-1111-4111-8111-111111111111', code: 'P', name: 'n', settlementType: 'QUANTITY' }));
    expect((await json(missing)).error?.fields?.[0]).toMatchObject({ path: '/customerId', code: 'not_found' });

    const c = await create('customers', { code: 'CU-INACT', name: '無効化予定', closingDay: 31 });
    expect((await item.DELETE(req('DELETE', `customers/${c.id}`, { expectedVersion: 1 }))).status).toBe(204);
    const res = await collection.POST(req('POST', 'products', { customerId: c.id, code: 'P-X', name: 'n', settlementType: 'QUANTITY' }));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe('MASTER_INACTIVE');
  });

  it('無効化は物理削除しない（active=false で残り、version+1）、二重無効化は 409 STATE_CONFLICT', async () => {
    const w = await create('workers', { code: 'W-DEL', name: '退職予定' });
    expect((await item.DELETE(req('DELETE', `workers/${w.id}`, { expectedVersion: 1 }))).status).toBe(204);
    const after = await json(await item.GET(req('GET', `workers/${w.id}`)));
    expect(after.data).toMatchObject({ active: false, version: 2 });
    const again = await item.DELETE(req('DELETE', `workers/${w.id}`, { expectedVersion: 2 }));
    expect(again.status).toBe(409);
    expect((await json(again)).error?.code).toBe('STATE_CONFLICT');
  });
});

describe('T-MST-001 楽観ロック・所属変更禁止', () => {
  it('expectedVersion一致で更新（version+1）、古いversionは 409 currentVersion/changedFields', async () => {
    const c = await create('customers', { code: 'CU-LOCK', name: '旧名', closingDay: 20 });
    const ok = await item.PATCH(req('PATCH', `customers/${c.id}`, { code: 'CU-LOCK', name: '新名', closingDay: 20, expectedVersion: 1, reason: '社名変更' }));
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ name: '新名', version: 2 });

    const stale = await item.PATCH(req('PATCH', `customers/${c.id}`, { code: 'CU-LOCK', name: '別名', closingDay: 20, expectedVersion: 1, reason: '競合' }));
    expect(stale.status).toBe(409);
    const err = (await json(stale)).error;
    expect(err).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    expect(err?.changedFields).toContain('/name');
    const audit = await db.pool.query(`SELECT reason, before_data, after_data FROM app.audit_events WHERE target_id = $1 AND action = 'MASTER_UPDATE'`, [c.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toBe('社名変更');
  });

  it('品番の所属顧客は変更不可（422 immutable）', async () => {
    const c1 = await create('customers', { code: 'CU-A', name: 'A', closingDay: 31 });
    const c2 = await create('customers', { code: 'CU-B', name: 'B', closingDay: 31 });
    const p = await create('products', { customerId: c1.id, code: 'P-IMM', name: '品', settlementType: 'TIME' });
    const res = await item.PATCH(req('PATCH', `products/${p.id}`, { customerId: c2.id, code: 'P-IMM', name: '品', settlementType: 'TIME', expectedVersion: 1, reason: '移管' }));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/customerId', code: 'immutable' });
  });
});

describe('T-MST-001 ルール: 期間重複・遡及・preview', () => {
  let customerId: string;
  let productId: string;
  let workTypeId: string;

  beforeAll(async () => {
    customerId = (await create('customers', { code: 'CU-RULE', name: 'ルール顧客', closingDay: 31 })).id;
    productId = (await create('products', { customerId, code: 'P-RULE', name: '品番', settlementType: 'QUANTITY' })).id;
    workTypeId = (await create('work-types', { productId, code: 'INSP', name: '検査' })).id;
  });

  it('単価は10進文字列で保存、日付はずれない、金額は number', async () => {
    const r = await create('rates', { productId, workTypeId, unitPrice: '1234.5678', validFrom: '2026-01-01', validTo: '2026-06-30' });
    expect(r).toMatchObject({ unitPrice: '1234.5678', overtimeMultiplier: '1.2500', validFrom: '2026-01-01', validTo: '2026-06-30', workTypeId });
    const t = await create('transport-rules', { productId, transportType: 'ALLOCATED', amountYen: 2500, validFrom: '2026-01-01' });
    expect(t['amountYen']).toBe(2500);
  });

  it('有効ruleと期間重複は 422 /validFrom overlap', async () => {
    const res = await collection.POST(req('POST', 'rates', { productId, workTypeId, unitPrice: '999', validFrom: '2026-06-01' }));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/validFrom', code: 'overlap' });
  });

  it('作業種が品番に属していなければ 422 mismatch', async () => {
    const other = await create('products', { customerId, code: 'P-OTHER', name: '別品番', settlementType: 'QUANTITY' });
    const res = await collection.POST(req('POST', 'rates', { productId: other.id, workTypeId, unitPrice: '1', validFrom: '2027-01-01' }));
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/workTypeId', code: 'mismatch' });
  });

  it('遡及preview: 過去の承認済み実績と未確定請求runを数え、書込まない', async () => {
    const rate = (await json(await collection.GET(req('GET', 'rates')))).data as unknown as Array<{ id: string; version: number; validFrom: string }>;
    const target = rate.find((r) => r.validFrom === '2026-01-01');
    if (target === undefined) throw new Error('rate not found');
    // 過去の承認済み作業実績1件（2026-03-10）と OPEN の請求run1件を用意
    const wr = await db.pool.query<{ id: string }>(`INSERT INTO app.work_reports(report_no, status, owner_id) VALUES ('WR-1','APPROVED',$1) RETURNING id`, [adminId]);
    const rev = await db.pool.query<{ id: string }>(
      `INSERT INTO app.work_report_revisions(report_id, revision_no, work_date, reporter_id, customer_id, product_id, work_type_id, start_at, end_at,
         break_minutes, regular_minutes, overtime_minutes, regular_person_minutes, overtime_person_minutes, quantity)
       VALUES ($1,1,'2026-03-10',$2,$3,$4,$5,'2026-03-10T00:00:00Z','2026-03-10T02:00:00Z',0,120,0,120,0,100) RETURNING id`,
      [wr.rows[0]?.id, adminId, customerId, productId, workTypeId],
    );
    await db.pool.query(`UPDATE app.work_reports SET current_revision_id = $1 WHERE id = $2`, [rev.rows[0]?.id, wr.rows[0]?.id]);
    await db.pool.query(`INSERT INTO app.billing_runs(customer_id, period_start, period_end) VALUES ($1,'2026-03-01','2026-03-31')`, [customerId]);

    const res = await item.PATCH(req('PATCH', `rates/${target.id}?preview=true`, {
      productId, workTypeId, unitPrice: '1300', validFrom: '2026-01-01', validTo: '2026-06-30', expectedVersion: target.version, reason: '単価改定',
    }));
    expect(res.status).toBe(200);
    const impact = (await json(res)).data;
    expect(impactSchema?.(impact)).toBe(true);
    expect(impact).toMatchObject({ retroactive: true, affectedRecordCount: 1, affectedOpenBillingRunCount: 1, finalizedBillingUnaffected: true });
    const unchanged = (await json(await item.GET(req('GET', `rates/${target.id}`)))).data;
    expect(unchanged).toMatchObject({ unitPrice: '1234.5678', version: target.version });
  });

  it('過去期間ruleの無効化は reason 必須、無効化後は同期間に新ruleを登録できる', async () => {
    const list = (await json(await collection.GET(req('GET', 'rates')))).data as unknown as Array<{ id: string; version: number; validFrom: string }>;
    const target = list.find((r) => r.validFrom === '2026-01-01');
    if (target === undefined) throw new Error('rate not found');
    const noReason = await item.DELETE(req('DELETE', `rates/${target.id}`, { expectedVersion: target.version }));
    expect(noReason.status).toBe(422);
    expect((await json(noReason)).error?.fields?.[0]).toMatchObject({ path: '/reason', code: 'required' });
    expect((await item.DELETE(req('DELETE', `rates/${target.id}`, { expectedVersion: target.version, reason: '単価改定のため差替' }))).status).toBe(204);
    const audit = await db.pool.query(`SELECT after_data FROM app.audit_events WHERE target_id = $1 AND action = 'MASTER_DEACTIVATE'`, [target.id]);
    expect(audit.rows[0].after_data).toMatchObject({ active: false, retroactive: true });
    await create('rates', { productId, workTypeId, unitPrice: '1300', validFrom: '2026-01-01', validTo: '2026-06-30' });
  });
});

describe('T-MST-001 休日・担当者', () => {
  it('過去日の休日作成は audit に retroactive=true、無効化は reason 必須', async () => {
    const h = await create('holidays', { holidayDate: '2026-05-06', name: '振替休日' });
    expect(h['holidayDate']).toBe('2026-05-06');
    const audit = await db.pool.query(`SELECT after_data FROM app.audit_events WHERE target_id = $1`, [h.id]);
    expect(audit.rows[0].after_data.retroactive).toBe(true);
    expect((await item.DELETE(req('DELETE', `holidays/${h.id}`, { expectedVersion: 1 }))).status).toBe(422);
    expect((await item.DELETE(req('DELETE', `holidays/${h.id}`, { expectedVersion: 1, reason: '誤登録' }))).status).toBe(204);
  });

  it('同日休日の重複は 422 /holidayDate duplicate', async () => {
    await create('holidays', { holidayDate: '2026-12-31', name: '年末' });
    const res = await collection.POST(req('POST', 'holidays', { holidayDate: '2026-12-31', name: '重複' }));
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/holidayDate', code: 'duplicate' });
  });

  it('担当者: email は小文字で保存、担当品番は同一顧客のみ', async () => {
    const c = await create('customers', { code: 'CU-CT', name: '担当顧客', closingDay: 31 });
    const p = await create('products', { customerId: c.id, code: 'P-CT', name: '品', settlementType: 'QUANTITY' });
    const other = await create('customers', { code: 'CU-OT', name: '他社', closingDay: 31 });
    const op = await create('products', { customerId: other.id, code: 'P-OT', name: '他社品', settlementType: 'QUANTITY' });
    const k = await create('contacts', { customerId: c.id, code: 'K1', name: '担当', email: 'Tanto@Example.COM', sendDaily: true, dailyProductIds: [p.id] });
    expect(k).toMatchObject({ email: 'tanto@example.com', dailyProductIds: [p.id], invoiceProductIds: [] });
    const bad = await collection.POST(req('POST', 'contacts', { customerId: c.id, code: 'K2', name: '担当2', email: 'k2@example.com', invoiceProductIds: [op.id] }));
    expect((await json(bad)).error?.fields?.[0]).toMatchObject({ path: '/invoiceProductIds/0', code: 'mismatch' });
  });
});

describe('T-MST-001 権限（入口ガード経由）', () => {
  it('OFFICE の作成は 403、FIELD/AUDITOR の一覧は 200', async () => {
    expect((await collection.POST(req('POST', 'workers', { code: 'W-OF', name: 'n' }, ['OFFICE']))).status).toBe(403);
    expect((await collection.GET(req('GET', 'workers', undefined, ['FIELD']))).status).toBe(200);
    expect((await collection.GET(req('GET', 'workers', undefined, ['AUDITOR']))).status).toBe(200);
  });
});
