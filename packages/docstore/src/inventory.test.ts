import { describe, expect, it } from 'vitest';
import { allocateFifo, planDelivery, planInspection, planOpening, planReversal, planStocktake } from '@inspexor/domain';
import { MemoryDocStore } from './memory';
import { InventoryRejectedError, hasOpening, inventoryBalanceAsOf, readBalance, readMovements, registerMovements, type RegisterContext } from './inventory';

const ctx = (over: Partial<RegisterContext> = {}): RegisterContext => ({ actorId: 'u1', now: new Date('2026-11-18T00:00:00Z'), correlationId: 'c1', sourceKind: 'SCREEN', ...over });
const PID = 'p-mn';

async function opening(store: MemoryDocStore, adjust = 50, deposit = 0): Promise<void> {
  await store.runTransaction((tx) =>
    registerMovements(
      tx,
      PID,
      () => planOpening({ productId: PID, businessDate: '2026-09-01', adjust, lots: deposit ? [{ lotKey: '2026-08-31|開始', lotDate: '2026-08-31', lotLabel: '開始', quantity: deposit }] : [] }),
      ctx(),
    ),
  );
}

describe('docstore 在庫（INV-10 以外のデータ層）', () => {
  it('開始残高→検品（日報から）→残高の写しは取引の積み上げと一致、取引番号は連番', async () => {
    const store = new MemoryDocStore();
    await opening(store);
    const r = await store.runTransaction((tx) =>
      registerMovements(tx, PID, () => planInspection({ productId: PID, businessDate: '2026-09-02', lotKey: '2026-09-02|WR-1|1', lotLabel: '9/2 選別分', actual: 1248, defectTotal: 0, boxes: 5, unitsPerBox: 250, adjustManaged: true }), ctx({ sourceKind: 'REPORT', sourceReportId: 'WR-1', sourceRevisionId: 'rev1', sourceRevisionNo: 1 })),
    );
    expect(r.movements.map((m) => m.movementNo)).toEqual(['M000002', 'M000003']);
    const bal = await readBalance(store, PID);
    expect(bal).toMatchObject({ deposit: 1250, adjust: 48, lastSeq: 3, version: 2, openingDate: '2026-09-01' });
    const calc = await inventoryBalanceAsOf(store, PID);
    expect(calc.balance).toMatchObject({ deposit: bal?.deposit, adjust: bal?.adjust });
    expect(hasOpening(await readMovements(store, PID))).toBe(true);
  });

  it('INV-12 同じ品番の同時の納入: 片方だけ成功し二重引当にならない', async () => {
    const store = new MemoryDocStore();
    await opening(store, 0, 1000);
    const deliver = (n: number) => store.runTransaction((tx) => registerMovements(tx, PID, (ex) => planDelivery({ productId: PID, businessDate: '2026-09-02', allocations: allocateFifo(ex, PID, '2026-09-02', n) }), ctx()));
    const results = await Promise.allSettled([deliver(700), deliver(700)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await readBalance(store, PID))?.deposit).toBe(300);
  });

  it('預かり在庫が足りない納入は INVENTORY_LOT_SHORT。何も記録しない（INV-13 の相当）', async () => {
    const store = new MemoryDocStore();
    await opening(store, 0, 500);
    await expect(
      store.runTransaction((tx) =>
        registerMovements(tx, PID, (ex) => [...planDelivery({ productId: PID, businessDate: '2026-09-02', allocations: allocateFifo(ex, PID, '2026-09-02', 500) }), ...planDelivery({ productId: PID, businessDate: '2026-09-02', allocations: [{ lotKey: '2026-08-31|開始', lotDate: '2026-08-31', lotLabel: '開始', quantity: 100 }] })], ctx()),
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_LOT_SHORT' });
    expect((await readMovements(store, PID)).length).toBe(1);
    expect((await readBalance(store, PID))?.deposit).toBe(500);
  });

  it('調整用在庫の不足: 確認なしは INVENTORY_ADJUST_SHORT、確認のチェックがあれば記録し矛盾として残る', async () => {
    const store = new MemoryDocStore();
    await opening(store, 262);
    const plan = () => planInspection({ productId: PID, businessDate: '2026-09-02', lotKey: 'k', lotLabel: 'k', actual: 1250, defectTotal: 300, boxes: 5, unitsPerBox: 250, adjustManaged: true });
    const err = await store.runTransaction((tx) => registerMovements(tx, PID, plan, ctx())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryRejectedError);
    expect((err as InventoryRejectedError).code).toBe('INVENTORY_ADJUST_SHORT');
    expect((err as InventoryRejectedError).issues[0]).toMatchObject({ kind: 'ADJ_NEGATIVE', quantity: -38 });
    expect((await readMovements(store, PID)).length).toBe(1);
    await store.runTransaction((tx) => registerMovements(tx, PID, plan, ctx({ acknowledgeAdjustShort: true })));
    const bal = await readBalance(store, PID);
    expect(bal?.adjust).toBe(-38);
    expect(bal?.issues[0]).toMatchObject({ kind: 'ADJ_NEGATIVE' });
  });

  it('取消し: 元の取引と対で除かれ、同じ取引の2回目の取消しは追記できない（監査で止まる）', async () => {
    const store = new MemoryDocStore();
    await opening(store, 0, 1000);
    const del = await store.runTransaction((tx) => registerMovements(tx, PID, (ex) => planDelivery({ productId: PID, businessDate: '2026-09-02', allocations: allocateFifo(ex, PID, '2026-09-02', 400) }), ctx()));
    const target = del.movements[0]!;
    await store.runTransaction((tx) => registerMovements(tx, PID, (ex) => [planReversal(ex.find((m) => m.id === target.id)!, '誤入力')], ctx()));
    expect((await readBalance(store, PID))?.deposit).toBe(1000);
    await expect(store.runTransaction((tx) => registerMovements(tx, PID, (ex) => [planReversal(ex.find((m) => m.id === target.id)!, '二重')], ctx()))).rejects.toThrow('保存則');
  });

  it('棚卸: 数えた数との差を記録（理由必須）', async () => {
    const store = new MemoryDocStore();
    await opening(store, 100, 1000);
    await store.runTransaction((tx) => registerMovements(tx, PID, (ex) => planStocktake(ex, { productId: PID, businessDate: '2026-09-05', countDeposit: 990, countAdjust: 100, adjustManaged: true, reason: '数え直し' }), ctx()));
    expect(await readBalance(store, PID)).toMatchObject({ deposit: 990, adjust: 100 });
  });
});
