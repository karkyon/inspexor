/**
 * CHG-018 統合試験: 作業日報の確定と在庫の連動（INV-13 日報の確定の失敗で在庫の取引も残らない、INV-08 修正の冪等）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jstToInstant } from '@inspexor/domain';
import { createUser, inventoryBalanceAsOf, readMovements } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { writeSchema } from '../masters/schemas';
import { InventoryService } from '../inventory/inventory-service';
import { FieldReportService, FieldError, type FieldContext } from './field-report-service';

const NOW = new Date('2026-11-18T03:00:00.000Z');
let t: TestStore;
const m: Record<string, string> = {};
let fieldUser = '';
let officeUser = '';
let svc: FieldReportService;
let svcOff: FieldReportService;

const ctx = (userId: string, role: string): FieldContext => ({ actor: { userId, roles: [role] }, correlationId: '11111111-1111-4111-8111-111111111111', now: NOW });
async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  return (await new MasterService(t.store).create(type, writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: NOW })).id;
}
type Body = Record<string, unknown>;
const bodyRaw = (date: string, quantity: number, defect: number, inventory: Record<string, unknown> | null): Body => ({
  workDate: date, reporterId: fieldUser, customerId: m['c'] as string, productId: m['p'] as string, workTypeId: m['wt'] as string, lotNo: null,
  workerIds: [m['w'] as string], startAt: jstToInstant(date, '09:00'), endAt: jstToInstant(date, '12:00'), quantity,
  defects: defect > 0 ? [{ defectTypeId: m['d'] as string, quantity: defect }] : [], inventory,
});
const body = (date: string, quantity: number, defect: number, inventory: Record<string, unknown> | null) => bodyRaw(date, quantity, defect, inventory) as never;
const state = async () => {
  const r = await inventoryBalanceAsOf(t.store, m['p'] as string);
  return { deposit: r.balance.deposit, adjust: r.balance.adjust, count: r.movements.length };
};
async function confirm(s: FieldReportService, input: ReturnType<typeof body>): Promise<string> {
  const c = await s.createWork(input, ctx(fieldUser, 'FIELD'));
  await s.confirm('WORK', c.id, 1, ctx(fieldUser, 'FIELD'));
  return c.id;
}

beforeAll(async () => {
  t = createTestStore('field-inventory');
  fieldUser = (await createUser(t.store, { loginId: 'fi-field', passwordHash: 'x', displayName: '現場', roles: ['FIELD'] }, NOW)) as string;
  officeUser = (await createUser(t.store, { loginId: 'fi-office', passwordHash: 'x', displayName: '事務所', roles: ['OFFICE'] }, NOW)) as string;
  m['c'] = await master('customers', { code: 'FI-C', name: '丸五', closingDay: 31 });
  m['p'] = await master('products', { customerId: m['c'], code: 'MN139931', name: 'MN', settlementType: 'QUANTITY', inventoryManaged: true, unitsPerBox: 250, adjustStockManaged: true });
  m['wt'] = await master('work-types', { productId: m['p'], code: 'INSP', name: '検査' });
  m['d'] = await master('defects', { productId: m['p'], code: 'D1', name: '破れ', sortOrder: 1 });
  m['w'] = await master('workers', { code: 'FW1', name: '作業者' });
  svc = new FieldReportService(t.store, { inventoryEnabled: true });
  svcOff = new FieldReportService(t.store, { inventoryEnabled: false });
  const inv = new InventoryService(t.store);
  const c = { actorId: officeUser, roles: ['OFFICE'], correlationId: 'c', now: NOW };
  await inv.register(m['p'] as string, 'opening', { businessDate: '2026-09-01', adjust: 50, lots: [{ lotDate: '2026-08-31', quantity: 1000 }] }, c);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('日報の確定と在庫の連動', () => {
  it('検品・不良の補充・1箱回す・別日の納入が確定と同時に記録される', async () => {
    const id = await confirm(svc, body('2026-09-02', 1250, 5, { boxCount: 5, replenishBoxes: 1, deliveredQuantity: 1000, deliveredDate: '2026-09-03' }));
    expect(await state()).toEqual({ deposit: 1000, adjust: 50 - 5 + 250, count: 1 + 6 });
    const mv = await readMovements(t.store, m['p'] as string);
    expect(mv.filter((x) => x.meta.reportId === id).map((x) => `${x.type}:${x.businessDate}`).sort()).toEqual(['DELIVERY:2026-09-03', 'FILL:2026-09-02', 'INSPECT:2026-09-02', 'NG:2026-09-02', 'REPLENISH:2026-09-02']);
  });

  it('INV-13 預かり在庫が足りない納入は 422 INVENTORY_LOT_SHORT。日報は確定されず、取引も残らない', async () => {
    const before = await state();
    const c = await svc.createWork(body('2026-09-04', 1250, 0, { boxCount: 5, deliveredQuantity: 99999, deliveredDate: '2026-09-04' }), ctx(fieldUser, 'FIELD'));
    const err = await svc.confirm('WORK', c.id, 1, ctx(fieldUser, 'FIELD')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldError);
    expect((err as FieldError).code).toBe('INVENTORY_LOT_SHORT');
    expect(await state()).toEqual(before);
    expect((await svc.get('WORK', c.id, { userId: fieldUser, roles: ['FIELD'] }))['status']).toBe('DRAFT');
  });

  it('調整用在庫が足りなくなる確定は INVENTORY_ADJUST_SHORT。確認のチェックがあれば記録される', async () => {
    const before = await state();
    const c = await svc.createWork(body('2026-09-05', 1250, 400, { boxCount: 5 }), ctx(fieldUser, 'FIELD'));
    const err = await svc.confirm('WORK', c.id, 1, ctx(fieldUser, 'FIELD')).catch((e: unknown) => e);
    expect((err as FieldError).code).toBe('INVENTORY_ADJUST_SHORT');
    expect(await state()).toEqual(before);
    await svc.updateWork(c.id, { ...bodyRaw('2026-09-05', 1250, 400, { boxCount: 5, acknowledgeAdjustShort: true }), expectedVersion: 1 } as never, ctx(fieldUser, 'FIELD'));
    await svc.confirm('WORK', c.id, 2, ctx(fieldUser, 'FIELD'));
    expect((await state()).adjust).toBe(295 - 400);
  });

  it('INV-08 確定後の修正（再確定）は前の版の取引を取り消して作り直す。何度直しても預かりは増えない', async () => {
    const id = await confirm(svc, body('2026-09-06', 1000, 0, { boxCount: 4 }));
    const dep = (await state()).deposit;
    let version = 2;
    for (let n = 0; n < 3; n++) {
      await svcOff.revise('WORK', id, { expectedVersion: version, reason: '訂正' }, ctx(officeUser, 'OFFICE'));
      await svc.updateWork(id, { ...bodyRaw('2026-09-06', 1000, 0, { boxCount: 4 }), expectedVersion: version + 1 } as never, ctx(officeUser, 'OFFICE'));
      await svc.confirm('WORK', id, version + 2, ctx(officeUser, 'OFFICE'));
      version += 3;
      expect((await state()).deposit).toBe(dep);
    }
    const au = await inventoryBalanceAsOf(t.store, m['p'] as string);
    expect(au.issues.filter((i) => i.kind === 'LOT_NEGATIVE')).toHaveLength(0);
  });

  it('開始日より前の作業日、または機能が無効なら在庫を動かさない', async () => {
    const before = await state();
    await confirm(svc, body('2026-08-20', 500, 0, null));
    await confirm(svcOff, body('2026-09-10', 500, 0, { boxCount: 2 }));
    expect(await state()).toEqual(before);
  });
});
