/**
 * 日報の入力画面（STEP4）に出す在庫の見込み（確定前の表示）。確定時の実際の取引は domain の planReportInventory が作る。
 * ここは同じ規則の画面表示用の計算（SK-2026-08-MINI-09 検品＝ロットを名目数に合わせる／1箱回す／納入）。
 */
export interface InventoryEffectInput {
  readonly unitsPerBox: number;
  readonly adjustManaged: boolean;
  readonly adjustLowThreshold: number;
  readonly deposit: number;
  readonly adjust: number;
  readonly quantity: number;
  readonly defectTotal: number;
  readonly boxCount: number;
  readonly replenishBoxes: number;
  readonly deliveredQuantity: number;
}

export interface InventoryEffect {
  readonly good: number;
  readonly nominal: number;
  /** 調整用から補充する数（負なら余りを調整用に戻す） */
  readonly fill: number;
  readonly depositAfter: number;
  readonly adjustAfter: number;
  readonly adjustShort: boolean;
  readonly adjustLow: boolean;
  readonly depositShort: boolean;
  /** 箱数の目安（処理数量÷入数。四捨五入） */
  readonly suggestedBoxes: number;
}

export function suggestBoxes(quantity: number, unitsPerBox: number): number {
  return unitsPerBox > 0 ? Math.round(quantity / unitsPerBox) : 0;
}

export function computeInventoryEffect(i: InventoryEffectInput): InventoryEffect {
  const good = Math.max(0, i.quantity - i.defectTotal);
  const nominal = i.boxCount * i.unitsPerBox;
  const fill = i.adjustManaged ? nominal - good : 0;
  const lotAdded = i.adjustManaged ? nominal : good;
  const replenish = i.adjustManaged ? i.replenishBoxes * i.unitsPerBox : 0;
  const depositAfter = i.deposit + lotAdded - replenish - i.deliveredQuantity;
  const adjustAfter = i.adjust - fill + replenish;
  return {
    good,
    nominal,
    fill,
    depositAfter,
    adjustAfter,
    adjustShort: i.adjustManaged && adjustAfter < 0,
    adjustLow: i.adjustManaged && adjustAfter >= 0 && adjustAfter < i.adjustLowThreshold,
    depositShort: depositAfter < 0,
    suggestedBoxes: suggestBoxes(i.quantity, i.unitsPerBox),
  };
}
