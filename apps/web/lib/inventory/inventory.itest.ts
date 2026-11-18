/**
 * CHG-018 統合試験: 在庫管理（API-047〜052、INV-10 機能の無効・INV-11 権限・INV-12 同時登録・INV-13 は日報の確定と一緒のため field 側）。
 * HTTP handler（入口ガード込み）→ InventoryService → DocStore で通しで確かめる。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RoleCode } from '@inspexor/domain';
import { auditEventsFor, createUser, DocIdempotencyRepository, StoreAuditRepository } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { writeSchema } from '../masters/schemas';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { inventoryActionHandlers, inventoryExportHandlers, inventoryListHandlers, inventoryMonthlyHandlers, inventoryMovementsHandlers, inventoryPreviewHandlers, inventoryReverseHandlers, type InventoryRouteDeps } from './inventory-handlers';
import { InventoryService } from './inventory-service';
import { registerMovements } from '@inspexor/docstore';
import { planInspection } from '@inspexor/domain';

const SECRET = 'c'.repeat(32);
const NOW = new Date('2026-11-18T03:00:00.000Z');
let env: Record<string, string> = { INVENTORY_ENABLED: 'true' };
let t: TestStore;
let deps: InventoryRouteDeps;
const users: Record<string, string> = {};
let pMN = '';
let pFPR = '';
let pPlain = '';

type Who = 'field' | 'office' | 'admin' | 'auditor';
const ROLE: Record<Who, RoleCode> = { field: 'FIELD', office: 'OFFICE', admin: 'ADMIN', auditor: 'AUDITOR' };
let seq = 0;
const KEY = () => ({ 'idempotency-key': `inv-key-${(seq += 1)}`.padEnd(24, '0') });

function req(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  const payload = { sessionId: `sess-${who}`, userId: users[who] as string, displayName: who, roles: [ROLE[who]], issuedAt: '2026-11-18T02:55:00.000Z', lastActivityAt: '2026-11-18T02:55:00.000Z' };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`sess-${who}`, SECRET), 'content-type': 'application/json', ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Json = { data?: any; error?: { code: string; message: string; issues?: unknown[]; fields?: Array<{ path: string }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Json;
const post = (who: Who, pid: string, action: string, body: unknown) => inventoryActionHandlers(deps).POST(req(who, 'POST', `inventory/${pid}/${action}`, body, KEY()));
const get = async (who: Who, path: string) => json(await inventoryListHandlers(deps).GET(req(who, 'GET', path)));

async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  return (await new MasterService(t.store).create(type, writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW })).id;
}

beforeAll(async () => {
  t = createTestStore('inventory');
  for (const who of Object.keys(ROLE) as Who[]) users[who] = (await createUser(t.store, { loginId: `inv-${who}`, passwordHash: 'x', displayName: who, roles: [ROLE[who]] }, NOW)) as string;
  const c = await master('customers', { code: 'MARUGO', name: '丸五ゴム工業', closingDay: 31 });
  pMN = await master('products', { customerId: c, code: 'MN139931', name: 'MN139931', settlementType: 'QUANTITY', inventoryManaged: true, unitsPerBox: 250, adjustStockManaged: true, adjustLowThreshold: 20 });
  pFPR = await master('products', { customerId: c, code: 'MN139931 FPR', name: 'FPR', settlementType: 'QUANTITY', inventoryManaged: true, unitsPerBox: 360, adjustStockManaged: false });
  pPlain = await master('products', { customerId: c, code: 'OTHER', name: '在庫なし', settlementType: 'QUANTITY' });
  const idem = () => new DocIdempotencyRepository(t.store, () => NOW);
  deps = {
    service: () => new InventoryService(t.store),
    idempotency: idem,
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined }),
    env: () => env,
  };
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('INV-10 機能の無効（INVENTORY_ENABLED が無いと 404）', () => {
  it('どの API も 404', async () => {
    env = {};
    expect((await inventoryListHandlers(deps).GET(req('office', 'GET', 'inventory'))).status).toBe(404);
    expect((await inventoryMonthlyHandlers(deps).GET(req('office', 'GET', `inventory/${pMN}/monthly?month=2026-09`))).status).toBe(404);
    expect((await post('office', pMN, 'opening', { businessDate: '2026-09-01', adjust: 10 })).status).toBe(404);
    env = { INVENTORY_ENABLED: 'true' };
  });
});

describe('INV-11 権限', () => {
  it('FIELD は参照も登録もできない。AUDITOR は参照のみ', async () => {
    expect((await inventoryListHandlers(deps).GET(req('field', 'GET', 'inventory'))).status).toBe(403);
    expect((await post('field', pMN, 'delivery', { businessDate: '2026-09-02', quantity: 10 })).status).toBe(403);
    expect((await inventoryListHandlers(deps).GET(req('auditor', 'GET', 'inventory'))).status).toBe(200);
    expect((await post('auditor', pMN, 'opening', { businessDate: '2026-09-01', adjust: 10 })).status).toBe(403);
    expect((await post('office', pMN, 'bogus', { businessDate: '2026-09-01' })).status).toBe(404);
    expect((await inventoryListHandlers(deps).GET(req('office', 'GET', 'inventory?bogus=1'))).status).toBe(400);
  });
});

describe('在庫の登録と参照', () => {
  it('開始残高を登録するまで他の操作はできない（409）。在庫を管理しない品番は 404', async () => {
    const r = await post('office', pMN, 'delivery', { businessDate: '2026-09-02', quantity: 10 });
    expect(r.status).toBe(409);
    expect((await post('office', pPlain, 'opening', { businessDate: '2026-09-01', adjust: 0 })).status).toBe(404);
  });

  it('開始残高 → 一覧に出る。2回目の開始残高は 422', async () => {
    const res = await post('office', pMN, 'opening', { businessDate: '2026-09-01', adjust: 185, lots: [{ lotDate: '2026-08-31', quantity: 1500 }] });
    expect(res.status).toBe(201);
    const list = await get('office', 'inventory');
    const mn = list.data.find((x: { code: string }) => x.code === 'MN139931');
    expect(mn).toMatchObject({ deposit: 1500, adjust: 185, hasOpening: true, openingDate: '2026-09-01', adjustLow: false, unitsPerBox: 250 });
    expect(list.data.map((x: { code: string }) => x.code)).toEqual(['MN139931', 'MN139931 FPR']);
    expect((await post('office', pMN, 'opening', { businessDate: '2026-09-01', adjust: 1 })).status).toBe(422);
  });

  it('納入: preview は保存しない。確定すると古いロットから引き当て、監査に残る', async () => {
    const pv = await json(await post('office', pMN, 'delivery', { businessDate: '2026-09-02', quantity: 1000, preview: true }));
    expect(pv.data).toMatchObject({ depositDelta: -1000, adjustDelta: 0, issues: [] });
    expect(Object.keys(pv.data as object).sort()).toEqual(['adjustDelta', 'allocations', 'depositDelta', 'issues', 'movements']);
    expect(pv.data.movements).toHaveLength(1);
    expect((await get('office', 'inventory')).data[0].deposit).toBe(1500);
    const ok = await json(await post('office', pMN, 'delivery', { businessDate: '2026-09-02', quantity: 1000 }));
    expect(ok.data.balance).toEqual({ deposit: 500, adjust: 185 });
    const ev = await auditEventsFor(t.store, 'inventory', pMN);
    expect(ev.map((e) => e.action)).toContain('INVENTORY_DELIVERY');
  });

  it('預かり在庫を超える納入は 422 INVENTORY_LOT_SHORT（preview でも blocked）', async () => {
    const r = await post('office', pMN, 'delivery', { businessDate: '2026-09-03', quantity: 9999 });
    expect(r.status).toBe(422);
    expect((await json(r)).error?.code).toBe('INVENTORY_LOT_SHORT');
  });

  it('同じ Idempotency-Key の再送は同じ応答で二重に登録しない', async () => {
    const headers = KEY();
    const body = { businessDate: '2026-09-04', quantity: 100 };
    const a = await inventoryActionHandlers(deps).POST(req('office', 'POST', `inventory/${pMN}/delivery`, body, headers));
    const b = await inventoryActionHandlers(deps).POST(req('office', 'POST', `inventory/${pMN}/delivery`, body, headers));
    expect(a.status).toBe(201);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect((await get('office', 'inventory')).data[0].deposit).toBe(400);
  });

  it('日報の検品（調整用の不足）は確認なしでは INVENTORY_ADJUST_SHORT。調整用を管理する品番だけ「1箱回す」ができる', async () => {
    await t.store.runTransaction((tx) =>
      registerMovements(tx, pMN, () => planInspection({ productId: pMN, businessDate: '2026-09-05', lotKey: '2026-09-05|WR|1', lotLabel: '9/5', actual: 1250, defectTotal: 5, boxes: 5, unitsPerBox: 250, adjustManaged: true }), { actorId: 'x', now: NOW, correlationId: 'c', sourceKind: 'REPORT', sourceReportId: 'WR', sourceRevisionNo: 1 }),
    );
    expect((await get('office', 'inventory')).data[0]).toMatchObject({ deposit: 1650, adjust: 180 });
    const rep = await json(await post('office', pMN, 'replenish', { businessDate: '2026-09-06', lotKey: '2026-09-05|WR|1', boxes: 1 }));
    expect(rep.data.balance).toEqual({ deposit: 1400, adjust: 430 });
    // FPR は調整用在庫を管理しない
    await post('office', pFPR, 'opening', { businessDate: '2026-09-01', adjust: 0, lots: [{ lotDate: '2026-08-31', quantity: 720 }] });
    expect((await post('office', pFPR, 'replenish', { businessDate: '2026-09-02', lotKey: '2026-08-31|開始1', boxes: 1 })).status).toBe(422);
  });

  it('棚卸は理由必須。差を記録して残高が数えた数になる', async () => {
    expect((await post('office', pMN, 'stocktake', { businessDate: '2026-09-07', countedDeposit: 1390, countedAdjust: 430 })).status).toBe(422);
    const ok = await json(await post('office', pMN, 'stocktake', { businessDate: '2026-09-07', countedDeposit: 1390, countedAdjust: 430, reason: '数え直し' }));
    expect(ok.data.balance).toEqual({ deposit: 1390, adjust: 430 });
  });

  it('取引の一覧・取消し。日報の取引は取り消せず、画面の取引は取り消せる（二重は 409）', async () => {
    const list = await json(await inventoryMovementsHandlers(deps).GET(req('office', 'GET', `inventory/${pMN}/movements`)));
    const report = list.data.find((m: { sourceKind: string }) => m.sourceKind === 'REPORT');
    const screen = list.data.find((m: { type: string; sourceKind: string }) => m.type === 'DELIVERY' && m.sourceKind === 'SCREEN');
    expect(list.data[0].movementNo).toMatch(/^M\d{6}$/);
    const rv = (id: string, reason = '誤入力') => inventoryReverseHandlers(deps).POST(req('office', 'POST', `inventory/${pMN}/movements/${id}/reverse`, { reason }, KEY()));
    expect((await rv(report.id)).status).toBe(409);
    expect((await rv(screen.id, ' ')).status).toBe(422);
    const before = (await get('office', 'inventory')).data[0].deposit;
    expect((await rv(screen.id)).status).toBe(200);
    expect((await get('office', 'inventory')).data[0].deposit).toBe(before + screen.quantity);
    expect((await rv(screen.id)).status).toBe(409);
  });

  it('在庫集計表: 画面用の値と Excel（INSPECTION_MONTH / DELIVERY_MONTH）', async () => {
    const m = await json(await inventoryMonthlyHandlers(deps).GET(req('auditor', 'GET', `inventory/${pMN}/monthly?month=2026-09&countBy=INSPECTION_MONTH`)));
    expect(m.data.rows).toHaveLength(30);
    expect((await inventoryMonthlyHandlers(deps).GET(req('auditor', 'GET', `inventory/${pMN}/monthly?month=2026-9`))).status).toBe(400);
    const x = await inventoryExportHandlers(deps).GET(req('office', 'GET', 'inventory/monthly/export?month=2026-09&countBy=DELIVERY_MONTH'));
    expect(x.status).toBe(200);
    expect(x.headers.get('content-type')).toContain('spreadsheetml');
    expect((await x.arrayBuffer()).byteLength).toBeGreaterThan(500);
  });
});

describe('API-053 日報の入力画面用の在庫プレビュー', () => {
  it('現場（FIELD）も参照できる。productId 必須・未知の query は 400。FIELD は他の在庫 API を呼べない', async () => {
    const ok = await inventoryPreviewHandlers(deps).GET(req('field', 'GET', `work-reports/inventory-preview?productId=${pMN}`));
    expect(ok.status).toBe(200);
    const d = (await json(ok)).data as Record<string, unknown>;
    expect(d['productId']).toBe(pMN);
    expect(typeof d['deposit']).toBe('number');
    expect(d['hasOpening']).toBe(true);
    expect((await inventoryPreviewHandlers(deps).GET(req('field', 'GET', 'work-reports/inventory-preview'))).status).toBe(400);
    expect((await inventoryPreviewHandlers(deps).GET(req('field', 'GET', `work-reports/inventory-preview?productId=${pMN}&x=1`))).status).toBe(400);
    expect((await inventoryListHandlers(deps).GET(req('field', 'GET', 'inventory'))).status).toBe(403);
  });
});

describe('API-049 preview は query（?preview=true）でも本文でも指定できる', () => {
  it('query の preview=true は保存せず見込みを返す', async () => {
    const before = ((await json(await inventoryListHandlers(deps).GET(req('office', 'GET', 'inventory')))).data as Array<Record<string, unknown>>).find((b) => b['productId'] === pMN);
    const res = await inventoryActionHandlers(deps).POST(req('office', 'POST', `inventory/${pMN}/delivery?preview=true`, { businessDate: '2026-09-09', quantity: 10 }, KEY()));
    expect(res.status).toBe(200);
    expect(((await json(res)).data as Record<string, unknown>)['depositDelta']).toBe(-10);
    const after = ((await json(await inventoryListHandlers(deps).GET(req('office', 'GET', 'inventory')))).data as Array<Record<string, unknown>>).find((b) => b['productId'] === pMN);
    expect(after?.['deposit']).toBe(before?.['deposit']);
  });
});
