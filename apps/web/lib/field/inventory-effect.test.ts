import { describe, it, expect } from 'vitest';
import { computeInventoryEffect, suggestBoxes } from './inventory-effect';

const base = { unitsPerBox: 250, adjustManaged: true, adjustLowThreshold: 20, deposit: 1000, adjust: 50, quantity: 1250, defectTotal: 5, boxCount: 5, replenishBoxes: 0, deliveredQuantity: 0 };

describe('日報入力画面の在庫の見込み', () => {
  it('調整用を管理する品番は、ロットを箱数×入数に合わせる（不良5個は調整用から補充）', () => {
    const e = computeInventoryEffect(base);
    expect(e).toMatchObject({ good: 1245, nominal: 1250, fill: 5, depositAfter: 2250, adjustAfter: 45, adjustShort: false });
  });
  it('余りは調整用へ戻す', () => {
    expect(computeInventoryEffect({ ...base, quantity: 1260, defectTotal: 0 })).toMatchObject({ fill: -10, adjustAfter: 60 });
  });
  it('1箱回す・納入を反映する', () => {
    expect(computeInventoryEffect({ ...base, replenishBoxes: 1, deliveredQuantity: 1000 })).toMatchObject({ depositAfter: 1000, adjustAfter: 295 });
  });
  it('調整用が足りない・少ない・預かりが足りないを判定する', () => {
    expect(computeInventoryEffect({ ...base, defectTotal: 400 }).adjustShort).toBe(true);
    expect(computeInventoryEffect({ ...base, adjust: 22 }).adjustLow).toBe(true);
    expect(computeInventoryEffect({ ...base, deliveredQuantity: 99999 }).depositShort).toBe(true);
  });
  it('調整用を管理しない品番は良品のまま', () => {
    expect(computeInventoryEffect({ ...base, adjustManaged: false })).toMatchObject({ depositAfter: 2245, adjustAfter: 50, fill: 0 });
  });
  it('箱数の目安は四捨五入', () => {
    expect(suggestBoxes(1250, 250)).toBe(5);
    expect(suggestBoxes(1130, 250)).toBe(5);
    expect(suggestBoxes(1000, 0)).toBe(0);
  });
});
