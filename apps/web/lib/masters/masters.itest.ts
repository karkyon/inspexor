/**
 * G2 統合試験（T-MST-001 系 / REQ-MST-001 / CHG-001）。CHG-006: Firestore（エミュレータ、無ければ MemoryDocStore）に対し、
 * HTTP handler（入口ガード込み）→ MasterService → DocStore を通しで検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { RoleCode } from '@inspexor/domain';
import { auditEventsFor, C, createUser, StoreAuditRepository } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { MasterService } from './master-service';
import { masterCollectionHandlers, masterItemHandlers, type MasterRouteDeps } from './master-handlers';

const SECRET = 'm'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z'); // JST 2026-10-08 12:00
let t: TestStore;
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
  t = createTestStore('masters');
  adminId = (await createUser(t.store, { loginId: 'itest-admin', passwordHash: 'x', displayName: '管理者', roles: ['ADMIN'] }, NOW)) as string;
  deps = {
    service: () => new MasterService(t.store),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined }),
  };
  collection = masterCollectionHandlers(deps);
  item = masterItemHandlers(deps);
}, 60_000);

afterAll(async () => {
  await t?.close();
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
    const audit = await auditEventsFor(t.store, 'MASTER:customers', data?.id as string);
    expect(audit[0]).toMatchObject({ action: 'MASTER_CREATE', targetType: 'MASTER:customers' });
    expect(audit[0]?.correlationId).toBe(res.headers.get('x-correlation-id'));
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
    const audit = (await auditEventsFor(t.store, 'MASTER:customers', c.id)).filter((a) => a.action === 'MASTER_UPDATE');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('社名変更');
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

describe('CHG-006 F1: 請求専用マスタ（単価・運搬・固定費ルール）は Blind', () => {
  it('一覧・作成とも 404（未定義の種別と同じ）', async () => {
    for (const type of ['rates', 'transport-rules', 'fixed-charges']) {
      expect((await collection.GET(req('GET', type))).status).toBe(404);
      expect((await collection.POST(req('POST', type, { productId: '11111111-1111-4111-8111-111111111111', unitPrice: '1', validFrom: '2026-01-01' }))).status).toBe(404);
    }
  });
});

describe('CHG-009: 請求機能が有効なら請求マスタを使える（適用期間の重なり禁止）', () => {
  const billingDeps = (): MasterRouteDeps => ({
    service: () => new MasterService(t.store, { billing: true }),
    api: deps.api,
    env: () => ({ APPROVAL_ENABLED: 'true', BILLING_ENABLED: 'true' }),
  });
  const bc = () => masterCollectionHandlers(billingDeps());
  const bi = () => masterItemHandlers(billingDeps());
  const make = async (type: string, body: Record<string, unknown>) => {
    const res = await bc().POST(req('POST', type, body));
    return { status: res.status, body: await json(res) };
  };

  it('APPROVAL_ENABLED なしで BILLING_ENABLED だけでは無効（404）', async () => {
    const res = await masterCollectionHandlers({ ...billingDeps(), env: () => ({ BILLING_ENABLED: 'true' }) }).GET(req('GET', 'rates'));
    expect(res.status).toBe(404);
  });

  it('単価ルール: 作成・一覧。同じ品番・作業内容で期間が重なれば 422 overlap、作業内容が違えば可、無効化すれば同じ期間で再登録可', async () => {
    const c = await create('customers', { code: 'CU-BIL', name: '請求顧客', closingDay: 31 });
    const p = await create('products', { customerId: c.id, code: 'P-BIL', name: '請求品', settlementType: 'QUANTITY' });
    const wt = await create('work-types', { productId: p.id, code: 'WT1', name: '検査' });
    const r1 = await make('rates', { productId: p.id, unitPrice: '4.4', validFrom: '2026-01-01', validTo: '2026-06-30' });
    expect(r1.status).toBe(201);
    expect(masterRecordSchema?.(r1.body.data)).toBe(true);
    expect(r1.body.data).toMatchObject({ unitPrice: '4.4', overtimeMultiplier: '1.25', workTypeId: null });
    const clash = await make('rates', { productId: p.id, unitPrice: '5', validFrom: '2026-06-30' });
    expect(clash.status).toBe(422);
    expect(clash.body.error?.fields?.[0]).toMatchObject({ path: '/validFrom', code: 'overlap' });
    expect((await make('rates', { productId: p.id, unitPrice: '5', validFrom: '2026-07-01' })).status).toBe(201);
    expect((await make('rates', { productId: p.id, workTypeId: wt.id, unitPrice: '6', validFrom: '2026-01-01' })).status).toBe(201);
    // 無効化した期間には再登録できる
    expect((await bi().DELETE(req('DELETE', `rates/${r1.body.data?.id}`, { expectedVersion: 1, reason: '単価改定' }))).status).toBe(204);
    expect((await make('rates', { productId: p.id, unitPrice: '4.5', validFrom: '2026-01-01', validTo: '2026-06-30' })).status).toBe(201);
    const list = await json(await bc().GET(req('GET', 'rates?pageSize=100')));
    expect((list.meta?.total ?? 0) >= 4).toBe(true);
  });

  it('単価ルール: 適用終了日 < 開始日・割増倍率 < 1・別品番の作業内容は 422。更新でも重なりを検査（自分自身は除く）', async () => {
    const c = await create('customers', { code: 'CU-BIL2', name: '請求顧客2', closingDay: 20 });
    const p = await create('products', { customerId: c.id, code: 'P-BIL2', name: '品2', settlementType: 'TIME' });
    const q = await create('products', { customerId: c.id, code: 'P-BIL3', name: '品3', settlementType: 'TIME' });
    const wtq = await create('work-types', { productId: q.id, code: 'WTQ', name: '別品番の作業' });
    expect((await make('rates', { productId: p.id, unitPrice: '1', validFrom: '2026-02-01', validTo: '2026-01-31' })).body.error?.fields?.[0]).toMatchObject({ path: '/validTo', code: 'range' });
    expect((await make('rates', { productId: p.id, unitPrice: '1', overtimeMultiplier: '0.9', validFrom: '2026-01-01' })).body.error?.fields?.[0]).toMatchObject({ path: '/overtimeMultiplier', code: 'min' });
    expect((await make('rates', { productId: p.id, workTypeId: wtq.id, unitPrice: '1', validFrom: '2026-01-01' })).body.error?.fields?.[0]).toMatchObject({ path: '/workTypeId', code: 'mismatch' });
    const a = await make('rates', { productId: p.id, unitPrice: '1980', validFrom: '2026-01-01', validTo: '2026-03-31' });
    const b = await make('rates', { productId: p.id, unitPrice: '2000', validFrom: '2026-04-01' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const self = await bi().PATCH(req('PATCH', `rates/${a.body.data?.id}`, { productId: p.id, unitPrice: '1990', validFrom: '2026-01-01', validTo: '2026-03-31', expectedVersion: 1, reason: '単価修正' }));
    expect(self.status).toBe(200);
    const extend = await bi().PATCH(req('PATCH', `rates/${a.body.data?.id}`, { productId: p.id, unitPrice: '1990', validFrom: '2026-01-01', validTo: '2026-04-30', expectedVersion: 2, reason: '延長' }));
    expect(extend.status).toBe(422);
  });

  it('運搬ルール: 運搬区分が違えば重なっても可（品番・作業内容・区分で判定）。固定費は品番＋費目', async () => {
    const c = await create('customers', { code: 'CU-BIL3', name: '請求顧客3', closingDay: 31 });
    const p = await create('products', { customerId: c.id, code: 'P-BIL4', name: '品4', settlementType: 'QUANTITY' });
    expect((await make('transport-rules', { productId: p.id, transportType: 'ALLOCATED', amountYen: 2500, validFrom: '2026-01-01' })).status).toBe(201);
    expect((await make('transport-rules', { productId: p.id, transportType: 'PER_TRIP', amountYen: 1000, validFrom: '2026-01-01' })).status).toBe(201);
    expect((await make('transport-rules', { productId: p.id, transportType: 'ALLOCATED', amountYen: 3000, validFrom: '2026-05-01' })).status).toBe(422);
    expect((await make('fixed-charges', { productId: p.id, label: '保管料', amountYen: 5000, validFrom: '2026-01-01' })).status).toBe(201);
    expect((await make('fixed-charges', { productId: p.id, label: '管理費', amountYen: 1000, validFrom: '2026-01-01' })).status).toBe(201);
    expect((await make('fixed-charges', { productId: p.id, label: '保管料', amountYen: 6000, validFrom: '2026-03-01' })).status).toBe(422);
  });
});

describe('T-MST-001 休日・担当者', () => {
  it('過去日の休日作成は audit に retroactive=true、無効化は reason 必須', async () => {
    const h = await create('holidays', { holidayDate: '2026-05-06', name: '振替休日' });
    expect(h['holidayDate']).toBe('2026-05-06');
    const audit = await auditEventsFor(t.store, 'MASTER:holidays', h.id);
    expect((audit[0]?.afterData as { retroactive: boolean }).retroactive).toBe(true);
    // 影響 preview: 確定済みの現在版がその日の作業実績を数える（報告ヘッダの current.businessDate）
    await t.store.runTransaction(async (tx) => {
      tx.create(`${C.workReports}/itest-wr-1`, { reportNo: 'WR-202605-000001', status: 'SUBMITTED', current: { businessDate: '2026-05-06' } });
      tx.create(`${C.workReports}/itest-wr-2`, { reportNo: 'WR-202605-000002', status: 'SUBMITTED', current: { businessDate: '2026-05-07' } });
    });
    const preview = await item.DELETE(req('DELETE', `holidays/${h.id}?preview=true`, { expectedVersion: 1 }));
    expect(preview.status).toBe(200);
    const impact = (await json(preview)).data;
    expect(impactSchema?.(impact)).toBe(true);
    expect(impact).toMatchObject({ retroactive: true, affectedRecordCount: 1, affectedOpenBillingRunCount: 0 });
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
