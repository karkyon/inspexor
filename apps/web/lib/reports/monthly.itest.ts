/**
 * CHG-004 D4 統合試験: 月次集計（API-027）と Excel/CSV 出力（API-028）。fresh DB（schema.sql＋migration）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jstToInstant, type RoleCode } from '@inspexor/domain';
import { createFreshDatabase, insertUser, type FreshDatabase } from '../testing/fresh-db';
import '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { FieldReportService } from '../field/field-report-service';
import { monthlyExportHandlers, monthlyHandlers, type MonthlyRouteDeps } from './monthly-handlers';

const SECRET = 'm'.repeat(32);
let db: FreshDatabase;
let deps: MonthlyRouteDeps;
const users: Record<string, string> = {};
const m: Record<string, string> = {};

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.pool.query(sql, params)).rows[0] as T;
}

function req(who: 'field' | 'office' | 'auditor', path: string): Request {
  const role: RoleCode = who === 'field' ? 'FIELD' : who === 'office' ? 'OFFICE' : 'AUDITOR';
  const payload = { sessionId: `s-${who}`, userId: users[who] as string, displayName: who, roles: [role], issuedAt: '2026-10-08T02:55:00.000Z', lastActivityAt: '2026-10-08T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}` } });
}

const ctx = (who: string, roles: string[]) => ({ actor: { userId: users[who] as string, roles }, correlationId: '00000000-0000-4000-8000-0000000000aa', now: new Date('2026-10-08T03:00:00Z') });

beforeAll(async () => {
  db = await createFreshDatabase('monthly');
  for (const [k, role] of [['field', 'FIELD'], ['office', 'OFFICE'], ['auditor', 'AUDITOR']] as const) {
    users[k] = await insertUser(db.pool, `mon-${k}`);
    await db.pool.query('INSERT INTO app.user_roles VALUES ($1, $2)', [users[k], role]);
  }
  m['c'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C1','丸五（合成）',31) RETURNING id`)).id;
  m['c2'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C2','他社',31) RETURNING id`)).id;
  m['pA'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'295C5','品A','QUANTITY') RETURNING id`, [m['c']])).id;
  m['pB'] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,'MR529673','品B','TIME') RETURNING id`, [m['c']])).id;
  m['tA'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','目視検査') RETURNING id`, [m['pA']])).id;
  m['tB'] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'BARI','バリ取り') RETURNING id`, [m['pB']])).id;
  m['dA'] = (await one(`INSERT INTO app.defect_types(product_id,code,name) VALUES ($1,'D1','バリ') RETURNING id`, [m['pA']])).id;
  m['w1'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W1','作業者1') RETURNING id`)).id;
  m['w2'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W2','作業者2') RETURNING id`)).id;
  const svc = new FieldReportService(db.pool);
  const f = ctx('field', ['FIELD']);
  const work = async (date: string, productId: string, workTypeId: string, start: string, end: string, qty: number, defects: Array<{ defectTypeId: string; quantity: number }>, workers: string[]) => {
    const r = await svc.createWork(
      { workDate: date, reporterId: users['field'] as string, customerId: m['c'] as string, productId, workTypeId, lotNo: null, workerIds: workers, startAt: jstToInstant(date, start), endAt: jstToInstant(date, end), quantity: qty, defects, workLocationId: null, vehicleId: null, remarks: null },
      f,
    );
    await svc.confirm('WORK', r.id, 1, f);
    return r.id;
  };
  // 8/19: 9:30–11:25 × 2名（提案書 P.9 の例: 実 1.92H / 総 3.83H）
  m['wr1'] = await work('2026-08-19', m['pA'] as string, m['tA'] as string, '09:30', '11:25', 1600, [{ defectTypeId: m['dA'] as string, quantity: 5 }], [m['w1'] as string, m['w2'] as string]);
  await work('2026-08-20', m['pB'] as string, m['tB'] as string, '13:00', '14:00', 896, [], [m['w1'] as string]);
  await work('2026-09-01', m['pA'] as string, m['tA'] as string, '09:00', '10:00', 99, [], [m['w1'] as string]); // 範囲外
  // 下書きのまま（集計に含めない）
  await svc.createWork(
    { workDate: '2026-08-21', reporterId: users['field'] as string, customerId: m['c'] as string, productId: m['pA'] as string, workTypeId: m['tA'] as string, lotNo: null, workerIds: [m['w1'] as string], startAt: jstToInstant('2026-08-21', '09:00'), endAt: jstToInstant('2026-08-21', '10:00'), quantity: 7, defects: [], workLocationId: null, vehicleId: null, remarks: null },
    f,
  );
  const dl = await svc.createDelivery(
    { deliveryDate: '2026-08-19', driverId: m['w1'] as string, customerId: m['c'] as string, items: [{ productId: m['pA'] as string, quantity: 1200 }, { productId: m['pB'] as string, quantity: 400 }], vehicleId: null, tripCount: 1, deliveryFeeYen: 2500 },
    f,
  );
  await svc.confirm('DELIVERY', dl.id, 1, f);
  const dl2 = await svc.createDelivery(
    { deliveryDate: '2026-08-20', driverId: m['w1'] as string, customerId: m['c'] as string, items: [{ productId: m['pA'] as string, quantity: 300 }], vehicleId: null, tripCount: 2, deliveryFeeYen: null },
    f,
  );
  await svc.confirm('DELIVERY', dl2.id, 1, f);
  // 修正中（版2が下書き）の報告は前の確定版で数える
  await svc.revise('WORK', m['wr1'] as string, { expectedVersion: 2, reason: '確認' }, ctx('office', ['OFFICE']));
  deps = { pool: () => db.pool, api: () => ({ sessionSecret: SECRET, now: () => new Date('2026-10-08T03:00:00Z'), auditRepository: new PgAuditRepository(db.pool), logError: () => undefined }) };
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Summary = { totals: Record<string, number>; daily: Array<Record<string, unknown>>; byProduct: Array<Record<string, unknown>>; byWorkType: Array<Record<string, unknown>>; rows: Array<Record<string, unknown>>; names: { products: Record<string, { code: string }> } };
const get = async (who: 'field' | 'office' | 'auditor', q: string) => {
  const res = await monthlyHandlers(deps).GET(req(who, `reports/monthly?${q}`));
  return { status: res.status, body: (await res.json()) as { data: Summary } };
};

describe('CHG-004 D4: 月次集計', () => {
  it('8月: 確定済みの現在版だけを集計（下書き・範囲外は除外、修正中は前の確定版）', async () => {
    const { status, body } = await get('office', 'month=2026-08');
    expect(status).toBe(200);
    expect(body.data.totals).toEqual({
      workCount: 2, workQuantity: 2496, defectQuantity: 5, actualMinutes: 175, personMinutes: 290,
      deliveryCount: 2, deliveryQuantity: 1900, tripCount: 3, deliveryFeeYen: 2500, deliveryFeeUnsetCount: 1,
    });
    expect(body.data.daily.map((d) => d['date'])).toEqual(['2026-08-19', '2026-08-20']);
    expect(body.data.byWorkType).toHaveLength(2);
    expect(Object.values(body.data.names.products).map((p) => p.code).sort()).toEqual(['295C5', 'MR529673']);
  });

  it('絞込: 品番（運搬は該当明細の数量のみ）・種別・お客様', async () => {
    const byProduct = (await get('office', `month=2026-08&productId=${m['pB']}`)).body.data.totals;
    expect(byProduct).toMatchObject({ workQuantity: 896, deliveryQuantity: 400, deliveryCount: 1, tripCount: 1, deliveryFeeYen: 2500 });
    const deliveryOnly = (await get('office', 'month=2026-08&type=DELIVERY')).body.data.totals;
    expect(deliveryOnly).toMatchObject({ workCount: 0, deliveryCount: 2 });
    const other = (await get('office', `month=2026-08&customerId=${m['c2']}`)).body.data.totals;
    expect(other).toMatchObject({ workCount: 0, deliveryCount: 0 });
  });

  it('権限と入力検査: FIELD は 403、AUDITOR は参照可、不正な年月・未知 query は 400', async () => {
    expect((await get('field', 'month=2026-08')).status).toBe(403);
    expect((await get('auditor', 'month=2026-08')).status).toBe(200);
    expect((await get('office', 'month=2026-13')).status).toBe(400);
    expect((await get('office', 'month=2026-08&x=1')).status).toBe(400);
    expect((await get('office', 'month=2026-08&productId=bad')).status).toBe(400);
  });

  it('Excel: 5シートの xlsx（ZIP）、日本語ファイル名', async () => {
    const res = await monthlyExportHandlers(deps).GET(req('office', 'reports/monthly/export?month=2026-08&format=xlsx'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('月次集計_2026-08.xlsx'));
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(buf);
    for (const name of ['集計', '日別', '品番別', '作業内容別', '明細']) expect(text).toContain(`<sheet name="${name}"`);
    expect(text).toContain('295C5');
  });

  it('CSV: シート単位・BOM・見出し、AUDITOR も出力可、不正な format/sheet は 400', async () => {
    const res = await monthlyExportHandlers(deps).GET(req('auditor', 'reports/monthly/export?month=2026-08&format=csv&sheet=daily'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM（Excel で文字化けしない）
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(csv.split('\r\n')[0]).toBe('﻿日付,作業個数,不良個数,実作業時間(H),総作業時間(人H),運搬数量,運搬回数,運搬費(円),運搬費未入力(件)');
    expect(csv).toContain('2026-08-19,1600,5,1.92,3.83,1600,1,2500,0');
    expect((await monthlyExportHandlers(deps).GET(req('office', 'reports/monthly/export?month=2026-08&format=pdf'))).status).toBe(400);
    expect((await monthlyExportHandlers(deps).GET(req('office', 'reports/monthly/export?month=2026-08&format=csv&sheet=x'))).status).toBe(400);
    expect((await monthlyExportHandlers(deps).GET(req('field', 'reports/monthly/export?month=2026-08&format=csv'))).status).toBe(403);
  });
});
