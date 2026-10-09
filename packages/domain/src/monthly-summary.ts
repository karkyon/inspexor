/**
 * 月次集計（提案書 SK-2026-08-MINI P.3/P.6/P.10 / CHG-004 D4）。framework/DB 非依存。
 *  - 対象: 指定年月（暦月 1日〜末日）の確定済み報告（最新の確定版）。下書きのみの報告は含めない
 *  - 作業: 作業個数・不良個数・実作業時間（休憩控除後の時間）・総作業時間（作業者数×時間）
 *  - 運搬: 運搬数量（品番明細の合計）・運搬回数・運搬費（手入力分の合計。未入力件数も示す）
 *  - 日別・品番別・作業内容別。運搬費の按分・単価・請求金額の計算はしない（提案書の対象外）
 *  値はすべて整数（個・分・円）。時間の表示換算（時間・小数）は出力時のみ。
 */

export interface WorkSummaryRow {
  readonly type: 'WORK';
  readonly reportId: string;
  readonly reportNo: string;
  readonly revisionNo: number;
  readonly date: string;
  readonly customerId: string;
  readonly productId: string;
  readonly workTypeId: string;
  readonly quantity: number;
  readonly defectQuantity: number;
  /** 休憩控除後の時間（分）= regular + overtime */
  readonly actualMinutes: number;
  /** 作業者数×時間（分）= regularPerson + overtimePerson */
  readonly personMinutes: number;
}

export interface DeliverySummaryRow {
  readonly type: 'DELIVERY';
  readonly reportId: string;
  readonly reportNo: string;
  readonly revisionNo: number;
  readonly date: string;
  readonly customerId: string;
  readonly items: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>;
  readonly tripCount: number;
  readonly deliveryFeeYen: number | null;
}

export type SummaryRow = WorkSummaryRow | DeliverySummaryRow;

export interface Totals {
  workCount: number;
  workQuantity: number;
  defectQuantity: number;
  actualMinutes: number;
  personMinutes: number;
  deliveryCount: number;
  deliveryQuantity: number;
  tripCount: number;
  deliveryFeeYen: number;
  deliveryFeeUnsetCount: number;
}

export interface DailyTotals extends Totals {
  readonly date: string;
}

export interface ProductTotals {
  readonly productId: string;
  workQuantity: number;
  defectQuantity: number;
  actualMinutes: number;
  personMinutes: number;
  deliveryQuantity: number;
}

export interface WorkTypeTotals {
  readonly productId: string;
  readonly workTypeId: string;
  workCount: number;
  workQuantity: number;
  defectQuantity: number;
  actualMinutes: number;
  personMinutes: number;
}

export interface MonthlySummary {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly totals: Totals;
  readonly daily: DailyTotals[];
  readonly byProduct: ProductTotals[];
  readonly byWorkType: WorkTypeTotals[];
  readonly rows: SummaryRow[];
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

/** 'YYYY-MM' → 暦月の初日・末日 */
export function monthRange(month: string): { from: string; to: string } {
  const m = MONTH_RE.exec(month);
  if (m === null) throw new Error(`invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function emptyTotals(): Totals {
  return { workCount: 0, workQuantity: 0, defectQuantity: 0, actualMinutes: 0, personMinutes: 0, deliveryCount: 0, deliveryQuantity: 0, tripCount: 0, deliveryFeeYen: 0, deliveryFeeUnsetCount: 0 };
}

function add(t: Totals, r: SummaryRow, productId: string | null): void {
  if (r.type === 'WORK') {
    t.workCount += 1;
    t.workQuantity += r.quantity;
    t.defectQuantity += r.defectQuantity;
    t.actualMinutes += r.actualMinutes;
    t.personMinutes += r.personMinutes;
    return;
  }
  t.deliveryCount += 1;
  t.deliveryQuantity += r.items.filter((i) => productId === null || i.productId === productId).reduce((s, i) => s + i.quantity, 0);
  t.tripCount += r.tripCount;
  if (r.deliveryFeeYen === null) t.deliveryFeeUnsetCount += 1;
  else t.deliveryFeeYen += r.deliveryFeeYen;
}

function assertSafe(t: Totals): void {
  for (const [k, v] of Object.entries(t)) {
    if (!Number.isSafeInteger(v)) throw new Error(`集計値が安全な整数の範囲を超えました: ${k}`);
  }
}

/**
 * rows は呼出側で期間・お客様・品番・種別を絞り込み済み（品番指定時、運搬は該当品番を含む報告）。
 * productId を渡すと運搬数量はその品番の明細だけを数える（運搬回数・運搬費は報告単位のまま）。
 */
export function summarizeMonth(month: string, rows: readonly SummaryRow[], productId: string | null = null): MonthlySummary {
  const { from, to } = monthRange(month);
  const sorted = [...rows].sort((a, b) => (a.date === b.date ? a.reportNo.localeCompare(b.reportNo) : a.date.localeCompare(b.date)));
  const totals = emptyTotals();
  const daily = new Map<string, DailyTotals>();
  const byProduct = new Map<string, ProductTotals>();
  const byWorkType = new Map<string, WorkTypeTotals>();
  const product = (id: string): ProductTotals => {
    let p = byProduct.get(id);
    if (p === undefined) {
      p = { productId: id, workQuantity: 0, defectQuantity: 0, actualMinutes: 0, personMinutes: 0, deliveryQuantity: 0 };
      byProduct.set(id, p);
    }
    return p;
  };
  for (const r of sorted) {
    if (r.date < from || r.date > to) continue;
    add(totals, r, productId);
    let d = daily.get(r.date);
    if (d === undefined) {
      d = { date: r.date, ...emptyTotals() };
      daily.set(r.date, d);
    }
    add(d, r, productId);
    if (r.type === 'WORK') {
      const p = product(r.productId);
      p.workQuantity += r.quantity;
      p.defectQuantity += r.defectQuantity;
      p.actualMinutes += r.actualMinutes;
      p.personMinutes += r.personMinutes;
      const key = `${r.productId}:${r.workTypeId}`;
      let w = byWorkType.get(key);
      if (w === undefined) {
        w = { productId: r.productId, workTypeId: r.workTypeId, workCount: 0, workQuantity: 0, defectQuantity: 0, actualMinutes: 0, personMinutes: 0 };
        byWorkType.set(key, w);
      }
      w.workCount += 1;
      w.workQuantity += r.quantity;
      w.defectQuantity += r.defectQuantity;
      w.actualMinutes += r.actualMinutes;
      w.personMinutes += r.personMinutes;
    } else {
      for (const i of r.items) {
        if (productId !== null && i.productId !== productId) continue;
        product(i.productId).deliveryQuantity += i.quantity;
      }
    }
  }
  assertSafe(totals);
  return {
    month,
    from,
    to,
    totals,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byProduct: [...byProduct.values()],
    byWorkType: [...byWorkType.values()],
    rows: sorted.filter((r) => r.date >= from && r.date <= to),
  };
}

/** 分 → 時間（小数2桁、表示・出力用） */
export function minutesToHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  // 1分 = 1/60 時間。小数2桁に四捨五入（表示のみ。集計は分の整数で行う）
  const frac = Math.round((rem * 100) / 60);
  return frac === 100 ? `${h + 1}.00` : `${h}.${String(frac).padStart(2, '0')}`;
}

/** CSV（RFC 4180、CRLF、Excel で開けるよう UTF-8 BOM 付き） */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const cell = (v: string | number | null): string => {
    if (v === null) return '';
    const s = String(v);
    // 数式として解釈される先頭文字は無害化（CSV injection 対策）
    const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
