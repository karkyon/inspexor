/**
 * G3 統合試験（T-DLV-001 / T-WRK-001 / T-OFF-001 の server 側 / REQ-REV-001 / CHG-002）。
 * 実PostgreSQL 16 の fresh DB（schema.sql＋migration）に対し、HTTP handler（入口ガード込み）→ FieldReportService → DB を通しで検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { RoleCode } from '@inspexor/domain';
import { jstToInstant } from '@inspexor/domain';
import { createFreshDatabase, insertUser, findSpecFile, type FreshDatabase } from '../testing/fresh-db';
import '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { FieldReportService } from './field-report-service';
import { deliveryFeeHandlers, fieldCollectionHandlers, fieldConfirmHandlers, fieldItemHandlers, recordListHandlers, recordTransitionHandlers, type FieldRouteDeps } from './field-handlers';

const SECRET = 'f'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z'); // JST 2026-10-08 12:00
let db: FreshDatabase;
let deps: FieldRouteDeps;
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

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.pool.query(sql, params)).rows[0] as T;
}

beforeAll(async () => {
  db = await createFreshDatabase('field');
  for (const [login, role] of [['field-a', 'FIELD'], ['field-b', 'FIELD'], ['office', 'OFFICE'], ['admin', 'ADMIN'], ['auditor', 'AUDITOR']] as const) {
    users[login] = await insertUser(db.pool, `itest-${login}`);
    await db.pool.query('INSERT INTO app.user_roles (user_id, role) VALUES ($1, $2)', [users[login], role]);
  }
  m['customer'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C1','顧客1',31) RETURNING id`)).id;
  m['customer2'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C2','顧客2',31) RETURNING id`)).id;
  m['pA'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'P-A','品A','QUANTITY') RETURNING id`, [m['customer']])).id;
  m['pB'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'P-B','品B','TIME') RETURNING id`, [m['customer']])).id;
  m['pLot'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type,lot_required) VALUES ($1,'P-L','ロット必須','QUANTITY',true) RETURNING id`, [m['customer']])).id;
  m['pOther'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'P-X','他社品','QUANTITY') RETURNING id`, [m['customer2']])).id;
  m['wtA'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','検査') RETURNING id`, [m['pA']])).id;
  m['wtB'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','検査') RETURNING id`, [m['pB']])).id;
  m['wtLot'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','検査') RETURNING id`, [m['pLot']])).id;
  m['dA1'] = (await one(`INSERT INTO app.defect_types(product_id,code,name,sort_order) VALUES ($1,'D1','バリ',1) RETURNING id`, [m['pA']])).id;
  m['dA2'] = (await one(`INSERT INTO app.defect_types(product_id,code,name,sort_order) VALUES ($1,'D2','欠け',2) RETURNING id`, [m['pA']])).id;
  m['dB1'] = (await one(`INSERT INTO app.defect_types(product_id,code,name,sort_order) VALUES ($1,'D1','バリ',1) RETURNING id`, [m['pB']])).id;
  m['w1'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W1','作業者1') RETURNING id`)).id;
  m['w2'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W2','作業者2') RETURNING id`)).id;
  m['wOff'] = (await one(`INSERT INTO app.workers(code,name,active) VALUES ('W9','無効作業者',false) RETURNING id`)).id;
  await db.pool.query(`INSERT INTO app.transport_rules(product_id,type,amount_yen,valid_from) VALUES ($1,'ALLOCATED',2500,'2026-01-01')`, [m['pA']]);
  await db.pool.query(`INSERT INTO app.transport_rules(product_id,type,amount_yen,valid_from) VALUES ($1,'PER_TRIP',1000,'2026-01-01')`, [m['pB']]);
  await db.pool.query(`INSERT INTO app.holidays(holiday_date,name) VALUES ('2026-11-03','文化の日')`);
  deps = {
    service: () => new FieldReportService(db.pool),
    pool: () => db.pool,
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new PgAuditRepository(db.pool), logError: () => undefined }),
  };
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

type Who = 'field-a' | 'field-b' | 'office' | 'admin' | 'auditor';
const ROLE: Record<Who, RoleCode> = { 'field-a': 'FIELD', 'field-b': 'FIELD', office: 'OFFICE', admin: 'ADMIN', auditor: 'AUDITOR' };

function req(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const payload = {
    sessionId: `sess-${who}`,
    userId: users[who] as string,
    displayName: who,
    roles: [ROLE[who]],
    issuedAt: '2026-10-08T02:55:00.000Z',
    lastActivityAt: '2026-10-08T02:55:00.000Z',
  };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`,
      'x-csrf-token': issueCsrfToken(`sess-${who}`, SECRET),
      'content-type': 'application/json',
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type Json = {
  data?: Record<string, unknown> & { id: string; version: number; status: string; reportNo: string };
  meta?: Record<string, number> | null;
  error?: { code: string; fields?: Array<{ path: string; code: string; message: string }>; currentVersion?: number; changedFields?: string[] };
};
const json = async (res: Response) => (await res.json()) as Json;

const work = (who: Who = 'field-a', over: Record<string, unknown> = {}) => ({
  workDate: '2026-10-08',
  reporterId: users[who],
  customerId: m['customer'],
  productId: m['pA'],
  workTypeId: m['wtA'],
  lotNo: '  LOT-1  ',
  workerIds: [m['w1'], m['w2']],
  startAt: jstToInstant('2026-10-08', '13:00'),
  endAt: jstToInstant('2026-10-08', '18:00'),
  quantity: 1600,
  defects: [{ defectTypeId: m['dA1'], quantity: 8 }, { defectTypeId: m['dA2'], quantity: 4 }],
  ...over,
});
const delivery = (over: Record<string, unknown> = {}) => ({
  deliveryDate: '2026-10-08',
  driverId: m['w1'],
  customerId: m['customer'],
  items: [{ productId: m['pA'], quantity: 1200 }, { productId: m['pB'], quantity: 800 }],
  ...over,
});

const W = () => ({ col: fieldCollectionHandlers('WORK', deps), item: fieldItemHandlers('WORK', deps), confirm: fieldConfirmHandlers('WORK', deps) });
const D = () => ({ col: fieldCollectionHandlers('DELIVERY', deps), item: fieldItemHandlers('DELIVERY', deps), confirm: fieldConfirmHandlers('DELIVERY', deps) });
const KEY = (s: string) => ({ 'idempotency-key': `itest-key-${s}`.padEnd(20, '0') });

async function createWork(who: Who = 'field-a', over: Record<string, unknown> = {}) {
  const res = await W().col.POST(req(who, 'POST', 'work-reports', work(who, over)));
  const j = await json(res);
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(j)}`);
  return j.data as NonNullable<Json['data']>;
}

describe('G3: 作業日報（API-004〜007）', () => {
  it('作成: 201 DRAFT、報告番号 WR-202610-000001、分計算、ロット trim、audit', async () => {
    const created = await createWork();
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, reportNo: 'WR-202610-000001', type: 'WORK', businessDate: '2026-10-08', revisionNo: 1 });
    expect(schema('Record')(created)).toBe(true);
    const res = await W().item.GET(req('field-a', 'GET', `work-reports/${created.id}`));
    const d = (await json(res)).data as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(schema('WorkReportDetail')(d), JSON.stringify(schema('WorkReportDetail').errors)).toBe(true);
    expect(d).toMatchObject({ lotNo: 'LOT-1', confirmedAt: null, regularMinutes: 240, overtimeMinutes: 60, regularPersonMinutes: 480, overtimePersonMinutes: 120, breakMinutes: 0 });
    expect(d['workerIds']).toEqual([m['w1'], m['w2']]);
    const audit = await one<{ n: string }>(`SELECT count(*) n FROM app.audit_events WHERE action='WORK_REPORT_CREATE' AND target_id=$1`, [created.id]);
    expect(Number(audit.n)).toBe(1);
    const second = await createWork();
    expect(second.reportNo).toBe('WR-202610-000002');
  });

  it('関連master不整合は 422（品番/作業内容/不良/無効作業者/他社品/ロット必須/代理）', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ productId: m['pOther'] }, '/productId', 'mismatch'],
      [{ workTypeId: m['wtB'] }, '/workTypeId', 'mismatch'],
      [{ defects: [{ defectTypeId: m['dB1'], quantity: 1 }] }, '/defects/0/defectTypeId', 'mismatch'],
      [{ workerIds: [m['wOff']] }, '/workerIds/0', 'inactive'],
      [{ productId: m['pLot'], workTypeId: m['wtLot'], defects: [], lotNo: '   ' }, '/lotNo', 'required'],
      [{ reporterId: users['field-b'] }, '/reporterId', 'proxy_unsupported'],
    ];
    for (const [over, path, code] of cases) {
      const res = await W().col.POST(req('field-a', 'POST', 'work-reports', work('field-a', over)));
      const j = await json(res);
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(j.error?.fields?.some((f) => f.path === path && f.code === code), JSON.stringify(j.error)).toBe(true);
    }
  });

  it('時間・数量の業務検証は 422（日跨ぎ・5分刻み・順序・不良>数量・作業者51名・数量上限）', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ endAt: jstToInstant('2026-10-09', '01:00') }, '/endAt'],
      [{ startAt: '2026-10-08T04:03:00Z' }, '/startAt'],
      [{ startAt: jstToInstant('2026-10-08', '18:00'), endAt: jstToInstant('2026-10-08', '13:00') }, '/endAt'],
      [{ quantity: 10, defects: [{ defectTypeId: m['dA1'], quantity: 11 }] }, '/defects'],
      [{ quantity: 1_000_000, defects: [] }, '/quantity'],
    ];
    for (const [over, path] of cases) {
      const res = await W().col.POST(req('field-a', 'POST', 'work-reports', work('field-a', over)));
      const j = await json(res);
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(j.error?.fields?.map((f) => f.path), JSON.stringify(j.error)).toContain(path);
    }
  });

  it('休日master・土日は全実働が割増（休憩控除）', async () => {
    const r = await createWork('field-a', { workDate: '2026-11-03', startAt: jstToInstant('2026-11-03', '09:00'), endAt: jstToInstant('2026-11-03', '18:00') });
    const d = (await json(await W().item.GET(req('field-a', 'GET', `work-reports/${r.id}`)))).data as Record<string, unknown>;
    expect(d).toMatchObject({ regularMinutes: 0, overtimeMinutes: 480, breakMinutes: 60, overtimePersonMinutes: 960 });
  });

  it('未知field・型不一致は 422、JSON不正は 400、ADMIN の作成は 403', async () => {
    expect((await W().col.POST(req('field-a', 'POST', 'work-reports', { ...work(), proxyReason: 'x' }))).status).toBe(422);
    const bad = new Request('https://example.com/api/v1/work-reports', { method: 'POST', headers: req('field-a', 'POST', 'work-reports').headers, body: '{' });
    expect((await W().col.POST(bad)).status).toBe(400);
    expect((await W().col.POST(req('admin', 'POST', 'work-reports', work('admin')))).status).toBe(403);
  });

  it('参照 scope: 他人の FIELD は 404（存在秘匿）、OFFICE/ADMIN/AUDITOR は可', async () => {
    const r = await createWork();
    expect((await W().item.GET(req('field-b', 'GET', `work-reports/${r.id}`))).status).toBe(404);
    for (const who of ['office', 'admin', 'auditor'] as const) {
      expect((await W().item.GET(req(who, 'GET', `work-reports/${r.id}`))).status).toBe(200);
    }
    expect((await W().item.GET(req('field-a', 'GET', 'work-reports/not-a-uuid'))).status).toBe(404);
  });

  it('更新: version+1、旧version は 409 VERSION_CONFLICT（currentVersion/changedFields）、他人FIELD 404、OFFICE 可', async () => {
    const r = await createWork();
    const up = await W().item.PATCH(req('field-a', 'PATCH', `work-reports/${r.id}`, { ...work('field-a', { quantity: 1500 }), expectedVersion: 1 }));
    expect(up.status).toBe(200);
    expect((await json(up)).data).toMatchObject({ version: 2, status: 'DRAFT' });
    const stale = await W().item.PATCH(req('field-a', 'PATCH', `work-reports/${r.id}`, { ...work('field-a', { quantity: 1400 }), expectedVersion: 1 }));
    const sj = await json(stale);
    expect(stale.status).toBe(409);
    expect(sj.error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    expect(sj.error?.changedFields).toContain('/quantity');
    expect((await W().item.PATCH(req('field-b', 'PATCH', `work-reports/${r.id}`, { ...work('field-a'), expectedVersion: 2 }))).status).toBe(404);
    const byOffice = await W().item.PATCH(req('office', 'PATCH', `work-reports/${r.id}`, { ...work('field-a'), expectedVersion: 2 }));
    expect(byOffice.status).toBe(200);
  });

  it('確定: 202 CONFIRMED、revision不変（DB trigger）、outbox WorkReportConfirmed、Idempotency（同key同payload=再生、異payload=409）', async () => {
    const r = await createWork();
    const res = await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 1 }, KEY('w1')));
    const j = await json(res);
    expect(res.status, JSON.stringify(j)).toBe(202);
    expect(j.data).toMatchObject({ status: 'CONFIRMED', version: 2, reportNo: r.reportNo });
    const replay = await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 1 }, KEY('w1')));
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(replay)).data).toMatchObject({ status: 'CONFIRMED', version: 2 });
    const conflict = await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 2 }, KEY('w1')));
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error?.code).toBe('IDEMPOTENCY_CONFLICT');
    const outbox = await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE event_type='WorkReportConfirmed' AND aggregate_id=$1`, [r.id]);
    expect(Number(outbox.n)).toBe(1);
    const header = await one<{ status: string; current_revision_id: string }>('SELECT status, current_revision_id FROM app.work_reports WHERE id=$1', [r.id]);
    const rev = await one<{ id: string; confirmed_at: Date | null }>('SELECT id, confirmed_at FROM app.work_report_revisions WHERE report_id=$1', [r.id]);
    expect(header).toMatchObject({ status: 'CONFIRMED', current_revision_id: rev.id });
    expect(rev.confirmed_at).not.toBeNull();
    await expect(db.pool.query('UPDATE app.work_report_revisions SET quantity = 1 WHERE id = $1', [rev.id])).rejects.toThrow(/immutable/);
    // 確定後の更新・再確定は 409 STATE_CONFLICT
    const patch = await W().item.PATCH(req('field-a', 'PATCH', `work-reports/${r.id}`, { ...work(), expectedVersion: 2 }));
    expect((await json(patch)).error?.code).toBe('STATE_CONFLICT');
    const again = await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 2 }, KEY('w2')));
    expect(again.status).toBe(409);
    expect((await json(again)).error?.code).toBe('STATE_CONFLICT');
  });

  it('確定時に master を再検証（下書き後に作業者が無効化されたら 422、記録は DRAFT のまま）、Idempotency-Key 欠落は 422', async () => {
    const tmp = (await one(`INSERT INTO app.workers(code,name) VALUES ('W-TMP','一時') RETURNING id`)).id;
    const r = await createWork('field-a', { workerIds: [tmp] });
    await db.pool.query('UPDATE app.workers SET active=false WHERE id=$1', [tmp]);
    const res = await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 1 }, KEY('w3')));
    expect(res.status).toBe(422);
    expect((await json(res)).error?.fields?.[0]).toMatchObject({ path: '/workerIds/0', code: 'inactive' });
    expect((await one<{ status: string }>('SELECT status FROM app.work_reports WHERE id=$1', [r.id])).status).toBe('DRAFT');
    expect((await W().confirm.POST(req('field-a', 'POST', `work-reports/${r.id}/confirm`, { expectedVersion: 1 }))).status).toBe(422);
  });
});

describe('G3: 運搬（API-008〜011）', () => {
  it('作成→参照→確定: DR番号、allocation_eligible（ALLOCATEDのみ true）、outbox DeliveryReportConfirmed', async () => {
    const res = await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery()));
    const j = await json(res);
    expect(res.status, JSON.stringify(j)).toBe(201);
    expect(j.data).toMatchObject({ reportNo: 'DR-202610-000001', status: 'DRAFT', version: 1, type: 'DELIVERY' });
    const id = j.data?.id as string;
    const c = await D().confirm.POST(req('field-a', 'POST', `delivery-reports/${id}/confirm`, { expectedVersion: 1 }, KEY('d1')));
    expect(c.status).toBe(202);
    const d = (await json(await D().item.GET(req('field-a', 'GET', `delivery-reports/${id}`)))).data as Record<string, unknown>;
    expect(schema('DeliveryReportDetail')(d), JSON.stringify(schema('DeliveryReportDetail').errors)).toBe(true);
    expect(d['status']).toBe('CONFIRMED');
    expect(d['items']).toEqual([
      { productId: m['pA'], quantity: 1200, allocationEligible: true },
      { productId: m['pB'], quantity: 800, allocationEligible: false },
    ]);
    const outbox = await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE event_type='DeliveryReportConfirmed' AND aggregate_id=$1`, [id]);
    expect(Number(outbox.n)).toBe(1);
  });

  it('422: 重複品番・他社品番・数量0（schema）・数量上限・無効運転者', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ items: [{ productId: m['pA'], quantity: 1 }, { productId: m['pA'], quantity: 2 }] }, 422, '/items/1/productId'],
      [{ items: [{ productId: m['pOther'], quantity: 1 }] }, 422, '/items/0/productId'],
      [{ items: [{ productId: m['pA'], quantity: 0 }] }, 422, '/items/0/quantity'],
      [{ items: [{ productId: m['pA'], quantity: 1_000_000 }] }, 422, '/items/0/quantity'],
      [{ driverId: m['wOff'] }, 422, '/driverId'],
    ];
    for (const [over, status, path] of cases) {
      const res = await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery(over)));
      const j = await json(res);
      expect(res.status, JSON.stringify(over)).toBe(status);
      expect(j.error?.fields?.map((f) => f.path)).toContain(path);
    }
  });

  it('更新は明細を置換し version+1', async () => {
    const created = (await json(await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery())))).data as NonNullable<Json['data']>;
    const up = await D().item.PATCH(req('field-a', 'PATCH', `delivery-reports/${created.id}`, { ...delivery({ items: [{ productId: m['pB'], quantity: 5 }] }), expectedVersion: 1 }));
    expect(up.status).toBe(200);
    const d = (await json(await D().item.GET(req('field-a', 'GET', `delivery-reports/${created.id}`)))).data as Record<string, unknown>;
    expect(d['version']).toBe(2);
    expect(d['items']).toEqual([{ productId: m['pB'], quantity: 5, allocationEligible: false }]);
  });
});

describe('G3: listRecords（API-012、CHG-002）', () => {
  it('FIELD は自分の分のみ、OFFICE は全件。業務日 DESC。status/date filter、未知query 400', async () => {
    await createWork('field-b', { workDate: '2026-10-07', startAt: jstToInstant('2026-10-07', '09:00'), endAt: jstToInstant('2026-10-07', '10:00'), defects: [] });
    const list = recordListHandlers(deps);
    const mine = await json(await list.GET(req('field-b', 'GET', 'records')));
    expect(mine.meta?.total).toBe(1);
    expect(schema('RecordPage')(mine)).toBe(true);
    const all = await json(await list.GET(req('office', 'GET', 'records?pageSize=100')));
    const rows = (all as unknown as { data: Array<{ businessDate: string; type: string }> }).data;
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.map((r) => r.businessDate)).toEqual([...rows.map((r) => r.businessDate)].sort().reverse());
    expect(rows.some((r) => r.type === 'DELIVERY')).toBe(true);
    // CHG-004 D5: 同じ業務日は新しい登録（作成日時）が先
    const created = await db.pool.query<{ id: string }>(`SELECT id FROM (SELECT id, created_at FROM app.work_reports UNION ALL SELECT id, created_at FROM app.delivery_reports) x ORDER BY created_at DESC, id ASC`);
    const sameDay = (all as unknown as { data: Array<{ id: string; businessDate: string }> }).data.filter((r) => r.businessDate === '2026-10-08').map((r) => r.id);
    expect(sameDay).toEqual(created.rows.map((r) => r.id).filter((id) => sameDay.includes(id)));
    const confirmed = await json(await list.GET(req('office', 'GET', 'records?status=CONFIRMED&dateFrom=2026-10-08&dateTo=2026-10-08')));
    expect((confirmed as unknown as { data: Array<{ status: string }> }).data.every((r) => r.status === 'CONFIRMED')).toBe(true);
    expect((await list.GET(req('office', 'GET', 'records?sort=x'))).status).toBe(400);
    expect((await list.GET(req('office', 'GET', 'records?status=DONE'))).status).toBe(400);
  });
});

describe('CHG-004: 提案書の入力項目（作業場所・使用車・備考／使用車両・運搬回数・運搬費）', () => {
  it('作業: 作業場所・使用車・備考を保存して Detail で返す（未指定は null）。無効な車両は 422', async () => {
    m['loc'] = (await one(`INSERT INTO app.work_locations(code,name) VALUES ('L1','三成興業 作業場') RETURNING id`)).id;
    m['car'] = (await one(`INSERT INTO app.vehicles(code,name) VALUES ('V1','キャラバン') RETURNING id`)).id;
    m['carOff'] = (await one(`INSERT INTO app.vehicles(code,name,active) VALUES ('V9','廃車',false) RETURNING id`)).id;
    const plain = await createWork('field-a');
    const plainDetail = (await json(await W().item.GET(req('field-a', 'GET', `work-reports/${plain.id}`)))).data as Record<string, unknown>;
    expect(plainDetail).toMatchObject({ workLocationId: null, vehicleId: null, remarks: null });
    expect(schema('WorkReportDetail')(plainDetail)).toBe(true);

    const created = await createWork('field-a', { workLocationId: m['loc'], vehicleId: m['car'], remarks: '  特記事項なし  ' });
    const detail = (await json(await W().item.GET(req('field-a', 'GET', `work-reports/${created.id}`)))).data as Record<string, unknown>;
    expect(detail).toMatchObject({ workLocationId: m['loc'], vehicleId: m['car'], remarks: '特記事項なし' });
    expect(schema('WorkReportDetail')(detail)).toBe(true);

    const bad = await W().col.POST(req('field-a', 'POST', 'work-reports', work('field-a', { vehicleId: m['carOff'] })));
    expect(bad.status).toBe(422);
    expect((await json(bad)).error?.fields?.map((f) => `${f.path}:${f.code}`)).toEqual(['/vehicleId:inactive']);
    const long = await W().col.POST(req('field-a', 'POST', 'work-reports', work('field-a', { remarks: 'あ'.repeat(501) })));
    expect(long.status).toBe(422);

    // 確定後の監査に備考の本文は残さない（有無のみ）
    const audit = await one<{ after_data: Record<string, unknown> }>(`SELECT after_data FROM app.audit_events WHERE target_id = $1 AND action = 'WORK_REPORT_CREATE'`, [created.id]);
    expect(JSON.stringify(audit.after_data)).not.toContain('特記事項なし');
  });

  it('運搬: 使用車両・運搬回数・運搬費（空欄可）を保存、PATCH で運搬費を後から入れられる、範囲外は 422', async () => {
    const d0 = await json(await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery())));
    const detail0 = (await json(await D().item.GET(req('field-a', 'GET', `delivery-reports/${d0.data?.id}`)))).data as Record<string, unknown>;
    expect(detail0).toMatchObject({ vehicleId: null, tripCount: 1, deliveryFeeYen: null });
    expect(schema('DeliveryReportDetail')(detail0)).toBe(true);

    const patched = await D().item.PATCH(
      req('field-a', 'PATCH', `delivery-reports/${d0.data?.id}`, { ...delivery({ vehicleId: m['car'], tripCount: 2, deliveryFeeYen: 2500 }), expectedVersion: 1 }),
    );
    expect(patched.status).toBe(200);
    const detail1 = (await json(await D().item.GET(req('field-a', 'GET', `delivery-reports/${d0.data?.id}`)))).data as Record<string, unknown>;
    expect(detail1).toMatchObject({ vehicleId: m['car'], tripCount: 2, deliveryFeeYen: 2500, version: 2 });
    expect(schema('DeliveryReportDetail')(detail1)).toBe(true);

    for (const over of [{ tripCount: 0 }, { tripCount: 100 }, { deliveryFeeYen: -1 }, { deliveryFeeYen: 10_000_000 }, { deliveryFeeYen: 1.5 }]) {
      expect((await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery(over)))).status).toBe(422);
    }
    const inactiveCar = await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery({ vehicleId: m['carOff'] })));
    expect((await json(inactiveCar)).error?.fields?.map((f) => `${f.path}:${f.code}`)).toEqual(['/vehicleId:inactive']);

    // 確定後も運搬回数・運搬費は保持
    const confirmed = await D().confirm.POST(req('field-a', 'POST', `delivery-reports/${d0.data?.id}/confirm`, { expectedVersion: 2 }, KEY('chg004-d')));
    expect(confirmed.status).toBe(202);
    const detail2 = (await json(await D().item.GET(req('field-a', 'GET', `delivery-reports/${d0.data?.id}`)))).data as Record<string, unknown>;
    expect(detail2).toMatchObject({ status: 'CONFIRMED', vehicleId: m['car'], tripCount: 2, deliveryFeeYen: 2500 });
  });
});

describe('CHG-004 batch16: 事務所の一覧絞込・確定後修正（新しい版）・運搬費の後入力', () => {
  it('一覧: 種別・お客様・品番で絞り込み、要約（お客様・品番・数量・運搬回数・運搬費）を返す。不正 query は 400', async () => {
    const list = recordListHandlers(deps);
    const dl = (await json(await list.GET(req('office', 'GET', `records?type=DELIVERY&productId=${m['pB']}&pageSize=100`)))) as unknown as { data: Array<Record<string, unknown>> };
    expect(dl.data.length).toBeGreaterThan(0);
    for (const r of dl.data) {
      expect(r['type']).toBe('DELIVERY');
      expect(r['productIds']).toContain(m['pB']);
      expect(r['customerId']).toBe(m['customer']);
      expect(typeof r['quantity']).toBe('number');
      expect(r['tripCount']).toBeGreaterThanOrEqual(1);
      expect(schema('Record')(r)).toBe(true);
    }
    const wk = (await json(await list.GET(req('office', 'GET', `records?type=WORK&customerId=${m['customer']}&pageSize=100`)))) as unknown as { data: Array<Record<string, unknown>> };
    expect(wk.data.every((r) => r['type'] === 'WORK' && r['tripCount'] === null && r['deliveryFeeYen'] === null && (r['productIds'] as string[]).length === 1)).toBe(true);
    const none = (await json(await list.GET(req('office', 'GET', `records?customerId=${m['customer2']}`)))) as unknown as { data: unknown[] };
    expect(none.data).toEqual([]);
    expect((await list.GET(req('office', 'GET', 'records?type=X'))).status).toBe(400);
    expect((await list.GET(req('office', 'GET', 'records?productId=abc'))).status).toBe(400);
  });

  it('revise: 確定済みを新しい下書き版にし（旧版は不変・親参照）、修正→確定で版2。理由必須、下書き・FIELD・承認系は不可', async () => {
    const created = await createWork('field-a');
    const t = recordTransitionHandlers(deps);
    const draftRevise = await t.POST(req('office', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 1, reason: '数量訂正' }, KEY('rv0')));
    expect(draftRevise.status).toBe(409);
    expect((await W().confirm.POST(req('field-a', 'POST', `work-reports/${created.id}/confirm`, { expectedVersion: 1 }, KEY('rv-c1')))).status).toBe(202);

    expect((await t.POST(req('office', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 2 }, KEY('rv1')))).status).toBe(422);
    expect((await t.POST(req('field-a', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 2, reason: 'x' }, KEY('rv2')))).status).toBe(403);
    expect((await t.POST(req('office', 'POST', `records/WORK/${created.id}/approve`, { expectedVersion: 2, reason: 'x' }, KEY('rv3')))).status).toBe(404);
    expect((await t.POST(req('office', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 1, reason: 'x' }, KEY('rv4')))).status).toBe(409);

    const ok = await t.POST(req('office', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 2, reason: '数量訂正' }, KEY('rv5')));
    expect(ok.status).toBe(200);
    const rec = (await json(ok)).data as Record<string, unknown>;
    expect(rec).toMatchObject({ status: 'DRAFT', version: 3, revisionNo: 2 });
    // 同じ key は再生（副作用1回）
    const replay = await t.POST(req('office', 'POST', `records/WORK/${created.id}/revise`, { expectedVersion: 2, reason: '数量訂正' }, KEY('rv5')));
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const revs = await db.pool.query<{ revision_no: number; parent_revision_id: string | null; confirmed_at: Date | null; quantity: number }>(
      'SELECT revision_no, parent_revision_id, confirmed_at, quantity FROM app.work_report_revisions WHERE report_id = $1 ORDER BY revision_no',
      [created.id],
    );
    expect(revs.rows).toHaveLength(2);
    expect(revs.rows[0]?.confirmed_at).not.toBeNull();
    expect(revs.rows[1]?.confirmed_at).toBeNull();
    expect(revs.rows[1]?.quantity).toBe(1600);
    const audit = await one<{ reason: string }>(`SELECT reason FROM app.audit_events WHERE target_id = $1 AND action = 'WORK_REPORT_REVISE'`, [created.id]);
    expect(audit.reason).toBe('数量訂正');

    // 事務所が修正して確定 → 版2が確定（版1は不変）、outbox が1件増える
    const detail = (await json(await W().item.GET(req('office', 'GET', `work-reports/${created.id}`)))).data as Record<string, unknown>;
    const body = { ...work('field-a', { quantity: 1500 }), expectedVersion: 3 };
    expect((await W().item.PATCH(req('office', 'PATCH', `work-reports/${created.id}`, body))).status).toBe(200);
    expect(detail['revisionNo']).toBe(2);
    expect((await W().confirm.POST(req('office', 'POST', `work-reports/${created.id}/confirm`, { expectedVersion: 4 }, KEY('rv-c2')))).status).toBe(202);
    const after = (await json(await W().item.GET(req('office', 'GET', `work-reports/${created.id}`)))).data as Record<string, unknown>;
    expect(after).toMatchObject({ status: 'CONFIRMED', revisionNo: 2, quantity: 1500 });
    expect((await one<{ quantity: number }>('SELECT quantity FROM app.work_report_revisions WHERE report_id = $1 AND revision_no = 1', [created.id])).quantity).toBe(1600);
    const events = await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE aggregate_id = $1 AND event_type = 'WorkReportConfirmed'`, [created.id]);
    expect(Number(events.n)).toBe(2);
  });

  it('運搬 revise は明細・運搬回数・使用車両を複製する', async () => {
    const d = await json(await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery({ tripCount: 3, vehicleId: m['car'] }))));
    const id = d.data?.id as string;
    await D().confirm.POST(req('field-a', 'POST', `delivery-reports/${id}/confirm`, { expectedVersion: 1 }, KEY('rvd-c')));
    const r = await recordTransitionHandlers(deps).POST(req('office', 'POST', `records/DELIVERY/${id}/revise`, { expectedVersion: 2, reason: '品番追加' }, KEY('rvd')));
    expect(r.status).toBe(200);
    const detail = (await json(await D().item.GET(req('office', 'GET', `delivery-reports/${id}`)))).data as Record<string, unknown>;
    expect(detail).toMatchObject({ status: 'DRAFT', revisionNo: 2, tripCount: 3, vehicleId: m['car'] });
    expect((detail['items'] as unknown[]).length).toBe(2);
  });

  it('運搬費の後入力: OFFICE は確定後に入力・修正・未確定へ戻せる（版は作らない）。下書き・FIELD・範囲外は不可、監査あり', async () => {
    const d = await json(await D().col.POST(req('field-a', 'POST', 'delivery-reports', delivery())));
    const id = d.data?.id as string;
    const fee = deliveryFeeHandlers(deps);
    expect((await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 1, deliveryFeeYen: 2500 }))).status).toBe(409);
    await D().confirm.POST(req('field-a', 'POST', `delivery-reports/${id}/confirm`, { expectedVersion: 1 }, KEY('fee-c')));
    expect((await fee.POST(req('field-a', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 2, deliveryFeeYen: 2500 }))).status).toBe(403);
    expect((await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 2, deliveryFeeYen: -1 }))).status).toBe(422);
    expect((await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 2, deliveryFeeYen: 625, extra: 1 }))).status).toBe(422);
    const ok = await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 2, deliveryFeeYen: 625 }));
    expect(ok.status).toBe(200);
    expect(((await json(ok)).data as Record<string, unknown>)['version']).toBe(3);
    expect((await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 2, deliveryFeeYen: 700 }))).status).toBe(409);
    expect((await fee.POST(req('office', 'POST', `delivery-reports/${id}/fee`, { expectedVersion: 3, deliveryFeeYen: null, reason: '金額確認中' }))).status).toBe(200);
    const detail = (await json(await D().item.GET(req('office', 'GET', `delivery-reports/${id}`)))).data as Record<string, unknown>;
    expect(detail).toMatchObject({ deliveryFeeYen: null, version: 4, revisionNo: 1, status: 'CONFIRMED' });
    const audits = await db.pool.query<{ after_data: { deliveryFeeYen: number | null }; reason: string | null }>(
      `SELECT after_data, reason FROM app.audit_events WHERE target_id = $1 AND action = 'DELIVERY_FEE_UPDATE' ORDER BY (before_data->>'version')::int`,
      [id],
    );
    expect(audits.rows.map((a) => a.after_data.deliveryFeeYen)).toEqual([625, null]);
    expect(audits.rows[1]?.reason).toBe('金額確認中');
  });
});
