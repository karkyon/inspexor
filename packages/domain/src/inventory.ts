/**
 * 在庫管理（SK-2026-08-MINI-09 在庫管理仕様書 2.0・CHG-015 第3版）の計算部品。
 * 試作画面 1.1 の `INV` と同じ計算を、型付きの純関数として移植したもの。
 * 在庫の正本は取引の記録（Movement）だけで、残高は記録を「業務日 → 登録順」に積み上げ直して求める。
 * 画面・API・データベースに依存しない（検算用データ inventory-golden.json で試験する）。
 */

export const EXT = {
  INTAKE: 'EXT:INTAKE',
  NG: 'EXT:NG',
  CUSTOMER: 'EXT:CUSTOMER',
  COUNT: 'EXT:COUNT',
  OPEN: 'EXT:OPEN',
} as const;

export type Bucket = 'LOT' | 'ADJ' | (typeof EXT)[keyof typeof EXT];

export type MovementType =
  | 'INSPECT'
  | 'NG'
  | 'FILL'
  | 'SURPLUS'
  | 'REPLENISH'
  | 'DELIVERY'
  | 'STOCKTAKE'
  | 'OPENING'
  | 'REVERSAL';

export interface MovementMeta {
  readonly actual?: number;
  readonly defectTotal?: number;
  readonly boxes?: number;
  readonly unitsPerBox?: number;
  readonly nominalQuantity?: number;
  readonly boxDifference?: number;
  readonly lotNo?: string;
  readonly ngBy?: Readonly<Record<string, number>>;
  readonly writer?: string;
  readonly hours?: number;
  readonly origType?: MovementType;
  /** 日報から作られた取引の元（日報の修正で前の版の取引を取り消すために使う） */
  readonly reportId?: string;
  readonly revisionNo?: number;
  readonly [key: string]: unknown;
}

export interface Movement {
  readonly id: string;
  readonly seq: number;
  readonly productId: string;
  readonly businessDate: string;
  readonly type: MovementType;
  readonly fromBucket: Bucket;
  readonly toBucket: Bucket;
  readonly lotKey?: string;
  readonly lotDate?: string;
  readonly lotLabel?: string;
  readonly quantity: number;
  readonly reason?: string;
  readonly reversalOf?: string;
  readonly meta: MovementMeta;
}

/** 取引の計画（登録前。id・seq は登録時に付ける） */
export type PlannedMovement = Omit<Movement, 'id' | 'seq'>;

export interface LotBalance {
  readonly lotKey: string;
  readonly lotDate: string;
  readonly lotLabel: string;
  readonly quantity: number;
}

export interface ProductBalance {
  readonly adjust: number;
  readonly deposit: number;
  readonly lots: readonly LotBalance[];
}

export type InventoryIssueKind = 'LOT_NEGATIVE' | 'ADJ_NEGATIVE';

export interface InventoryIssue {
  readonly kind: InventoryIssueKind;
  readonly productId: string;
  readonly businessDate: string;
  readonly lotKey?: string;
  readonly quantity: number;
  readonly movementId: string;
}

export interface ReplayResult {
  readonly balances: Readonly<Record<string, ProductBalance>>;
  readonly issues: readonly InventoryIssue[];
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** 業務日 → 登録順 */
export function compareMovements(a: Pick<Movement, 'businessDate' | 'seq'>, b: Pick<Movement, 'businessDate' | 'seq'>): number {
  if (a.businessDate === b.businessDate) return a.seq - b.seq;
  return a.businessDate < b.businessDate ? -1 : 1;
}

/** 取り消された取引の ID（取消しの reversalOf） */
export function reversedIds(movements: readonly Movement[]): Set<string> {
  const ids = new Set<string>();
  for (const m of movements) if (m.reversalOf) ids.add(m.reversalOf);
  return ids;
}

/** 取り消されていない通常の取引（取消し自体も除く） */
export function liveMovements(movements: readonly Movement[]): Movement[] {
  const r = reversedIds(movements);
  return movements.filter((m) => m.type !== 'REVERSAL' && !r.has(m.id));
}

interface MutableLot {
  lotKey: string;
  lotDate: string;
  lotLabel: string;
  quantity: number;
}
interface MutableState {
  lots: Map<string, MutableLot>;
  adjust: number;
}

/**
 * 積み上げ。取り消された取引と取消しは対で除く（記録は残る）。
 * untilDate を渡すとその日の終わりまで、untilSeq も渡すと同じ日のその登録順まで。
 */
export function replay(movements: readonly Movement[], untilDate?: string, untilSeq?: number): ReplayResult {
  const states = new Map<string, MutableState>();
  const issues: InventoryIssue[] = [];
  const stateOf = (pid: string): MutableState => {
    let s = states.get(pid);
    if (!s) {
      s = { lots: new Map(), adjust: 0 };
      states.set(pid, s);
    }
    return s;
  };
  const rv = reversedIds(movements);
  for (const m of [...movements].sort(compareMovements)) {
    if (m.type === 'REVERSAL' || rv.has(m.id)) continue;
    if (untilDate !== undefined && (m.businessDate > untilDate || (untilSeq !== undefined && m.businessDate === untilDate && m.seq > untilSeq))) break;
    const s = stateOf(m.productId);
    const lot = (): MutableLot => {
      const key = m.lotKey ?? '';
      let l = s.lots.get(key);
      if (!l) {
        l = { lotKey: key, lotDate: m.lotDate ?? m.businessDate, lotLabel: m.lotLabel ?? key, quantity: 0 };
        s.lots.set(key, l);
      }
      return l;
    };
    if (m.fromBucket === 'LOT') {
      const l = lot();
      l.quantity -= m.quantity;
      if (l.quantity < 0) issues.push({ kind: 'LOT_NEGATIVE', productId: m.productId, businessDate: m.businessDate, lotKey: m.lotKey ?? '', quantity: l.quantity, movementId: m.id });
    }
    if (m.toBucket === 'LOT') lot().quantity += m.quantity;
    if (m.fromBucket === 'ADJ') {
      s.adjust -= m.quantity;
      if (s.adjust < 0) issues.push({ kind: 'ADJ_NEGATIVE', productId: m.productId, businessDate: m.businessDate, quantity: s.adjust, movementId: m.id });
    }
    if (m.toBucket === 'ADJ') s.adjust += m.quantity;
  }
  const balances: Record<string, ProductBalance> = {};
  for (const [pid, s] of states) {
    const all = [...s.lots.values()];
    balances[pid] = {
      adjust: s.adjust,
      deposit: all.reduce((a, l) => a + l.quantity, 0),
      lots: all
        .filter((l) => l.quantity !== 0)
        .sort((a, b) => (a.lotDate === b.lotDate ? (a.lotKey < b.lotKey ? -1 : 1) : a.lotDate < b.lotDate ? -1 : 1))
        .map((l) => ({ lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: l.quantity })),
    };
  }
  return { balances, issues };
}

export const EMPTY_BALANCE: ProductBalance = { adjust: 0, deposit: 0, lots: [] };

export function balanceOf(movements: readonly Movement[], productId: string, untilDate?: string, untilSeq?: number): ProductBalance {
  return replay(movements, untilDate, untilSeq).balances[productId] ?? EMPTY_BALANCE;
}

const mv = (o: Omit<PlannedMovement, 'meta'> & { meta?: MovementMeta }): PlannedMovement => ({ ...o, meta: o.meta ?? {} });

export interface InspectionInput {
  readonly productId: string;
  readonly businessDate: string;
  readonly lotKey: string;
  readonly lotLabel: string;
  /** 選別した実数 */
  readonly actual: number;
  /** 不良の合計 */
  readonly defectTotal: number;
  readonly boxes: number;
  readonly unitsPerBox: number;
  /** 調整用在庫を管理する品番か */
  readonly adjustManaged: boolean;
  readonly meta?: MovementMeta;
}

export class InventoryInputError extends Error {}

/**
 * 検品（作業日報の確定）の取引。調整用在庫を管理する品番は、ロットを名目数（箱数×入数）に合わせる
 * （不足は調整用から補充、余りは調整用へ）。管理しない品番は良品のままにする。
 */
export function planInspection(input: InspectionInput): PlannedMovement[] {
  const { productId, businessDate, lotKey, lotLabel, actual, defectTotal, boxes, unitsPerBox, adjustManaged } = input;
  if (!isInt(actual) || !isInt(defectTotal) || actual < 0 || defectTotal < 0 || defectTotal > actual) throw new InventoryInputError('選別数・不良数が不正です');
  if (!isInt(boxes) || boxes < 0 || !isInt(unitsPerBox) || unitsPerBox < 1) throw new InventoryInputError('箱数・入数が不正です');
  const out: PlannedMovement[] = [];
  const good = actual - defectTotal;
  const base = input.meta ?? {};
  if (good > 0) {
    out.push(mv({ productId, businessDate, type: 'INSPECT', fromBucket: EXT.INTAKE, toBucket: 'LOT', lotKey, lotDate: businessDate, lotLabel, quantity: good, meta: { ...base, actual, defectTotal, boxes, unitsPerBox } }));
  }
  if (defectTotal > 0) {
    out.push(mv({ productId, businessDate, type: 'NG', fromBucket: EXT.INTAKE, toBucket: EXT.NG, quantity: defectTotal, meta: { lotKey } }));
  }
  if (adjustManaged) {
    const nominal = boxes * unitsPerBox;
    const fill = nominal - good;
    const meta: MovementMeta = { nominalQuantity: nominal, boxDifference: actual - nominal, actual, defectTotal };
    if (fill > 0) out.push(mv({ productId, businessDate, type: 'FILL', fromBucket: 'ADJ', toBucket: 'LOT', lotKey, lotDate: businessDate, lotLabel, quantity: fill, meta }));
    if (fill < 0) out.push(mv({ productId, businessDate, type: 'SURPLUS', fromBucket: 'LOT', toBucket: 'ADJ', lotKey, lotDate: businessDate, lotLabel, quantity: -fill, meta }));
  }
  return out;
}

export interface ReplenishInput {
  readonly productId: string;
  readonly businessDate: string;
  readonly lotKey: string;
  readonly lotDate: string;
  readonly lotLabel: string;
  readonly quantity: number;
  readonly reason?: string;
}

/** 預かり在庫の選んだ検品ロットから調整用在庫へ移す */
export function planReplenish(i: ReplenishInput): PlannedMovement[] {
  if (!isInt(i.quantity) || i.quantity <= 0) throw new InventoryInputError('数量が不正です');
  return [mv({ productId: i.productId, businessDate: i.businessDate, type: 'REPLENISH', fromBucket: 'LOT', toBucket: 'ADJ', lotKey: i.lotKey, lotDate: i.lotDate, lotLabel: i.lotLabel, quantity: i.quantity, ...(i.reason ? { reason: i.reason } : {}) })];
}

export interface Allocation {
  readonly lotKey: string;
  readonly lotDate: string;
  readonly lotLabel: string;
  readonly quantity: number;
}

/** 預かり在庫が足りない（納入・振替） */
export class InventoryLotShortError extends Error {
  constructor(
    readonly businessDate: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`預かり在庫が足りません（${businessDate} 時点で納入できるのは ${available} 個）`);
  }
}

/**
 * 納入の引き当て。その日の時点で預かり在庫が残っている検品ロットから、古い順（先入れ先出し）。
 * extra は同じ登録の中の未保存の取引（先に引き当てた物）。
 */
export function allocateFifo(movements: readonly Movement[], productId: string, businessDate: string, quantity: number): Allocation[] {
  if (!isInt(quantity) || quantity <= 0) throw new InventoryInputError('数量が不正です');
  const b = balanceOf(movements, productId, businessDate);
  let need = quantity;
  const out: Allocation[] = [];
  for (const l of b.lots) {
    if (need <= 0) break;
    if (l.quantity <= 0) continue;
    const t = Math.min(l.quantity, need);
    out.push({ lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: t });
    need -= t;
  }
  if (need > 0) throw new InventoryLotShortError(businessDate, quantity, quantity - need);
  return out;
}

export function planDelivery(i: { productId: string; businessDate: string; allocations: readonly Allocation[]; reason?: string }): PlannedMovement[] {
  return i.allocations.map((a) =>
    mv({ productId: i.productId, businessDate: i.businessDate, type: 'DELIVERY', fromBucket: 'LOT', toBucket: EXT.CUSTOMER, lotKey: a.lotKey, lotDate: a.lotDate, lotLabel: a.lotLabel, quantity: a.quantity, ...(i.reason ? { reason: i.reason } : {}) }),
  );
}

export interface StocktakeInput {
  readonly productId: string;
  readonly businessDate: string;
  readonly countDeposit: number;
  readonly countAdjust: number;
  readonly adjustManaged: boolean;
  readonly reason: string;
}

/** 棚卸。数えた数との差を記録する。預かりは減らすとき古いロットから、増やすときは「棚卸日｜棚卸」のロット */
export function planStocktake(movements: readonly Movement[], i: StocktakeInput): PlannedMovement[] {
  if (!i.reason.trim()) throw new InventoryInputError('棚卸の理由は必須です');
  if (!isInt(i.countDeposit) || i.countDeposit < 0 || !isInt(i.countAdjust) || i.countAdjust < 0) throw new InventoryInputError('数えた数が不正です');
  const b = balanceOf(movements, i.productId, i.businessDate);
  const out: PlannedMovement[] = [];
  const dDep = i.countDeposit - b.deposit;
  if (dDep < 0) {
    let need = -dDep;
    for (const l of b.lots) {
      if (need <= 0) break;
      const t = Math.min(l.quantity, need);
      if (t > 0) out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'STOCKTAKE', fromBucket: 'LOT', toBucket: EXT.COUNT, lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: t, reason: i.reason }));
      need -= t;
    }
  }
  if (dDep > 0) {
    out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'STOCKTAKE', fromBucket: EXT.COUNT, toBucket: 'LOT', lotKey: `${i.businessDate}|棚卸`, lotDate: i.businessDate, lotLabel: `${i.businessDate} 棚卸で増えた分`, quantity: dDep, reason: i.reason }));
  }
  if (i.adjustManaged) {
    const dA = i.countAdjust - b.adjust;
    if (dA < 0) out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'STOCKTAKE', fromBucket: 'ADJ', toBucket: EXT.COUNT, quantity: -dA, reason: i.reason }));
    if (dA > 0) out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'STOCKTAKE', fromBucket: EXT.COUNT, toBucket: 'ADJ', quantity: dA, reason: i.reason }));
  }
  return out;
}

export interface OpeningInput {
  readonly productId: string;
  readonly businessDate: string;
  readonly adjust: number;
  readonly lots: readonly { lotKey: string; lotDate: string; lotLabel: string; quantity: number }[];
}

/** 利用開始時の残高（調整用在庫と、預かり在庫の検品ロットごとの数） */
export function planOpening(i: OpeningInput): PlannedMovement[] {
  const out: PlannedMovement[] = [];
  if (!isInt(i.adjust) || i.adjust < 0) throw new InventoryInputError('調整用在庫の数が不正です');
  if (i.adjust > 0) out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'OPENING', fromBucket: EXT.OPEN, toBucket: 'ADJ', quantity: i.adjust }));
  for (const l of i.lots) {
    if (!isInt(l.quantity) || l.quantity < 0) throw new InventoryInputError('預かり在庫の数が不正です');
    if (l.quantity > 0) out.push(mv({ productId: i.productId, businessDate: i.businessDate, type: 'OPENING', fromBucket: EXT.OPEN, toBucket: 'LOT', lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: l.quantity }));
  }
  return out;
}

/** 取消し。元の取引と逆向き・同じ業務日・同じロット */
export function planReversal(m: Movement, reason: string): PlannedMovement {
  if (!reason.trim()) throw new InventoryInputError('取消しの理由は必須です');
  return mv({
    productId: m.productId,
    businessDate: m.businessDate,
    type: 'REVERSAL',
    fromBucket: m.toBucket,
    toBucket: m.fromBucket,
    ...(m.lotKey !== undefined ? { lotKey: m.lotKey } : {}),
    ...(m.lotDate !== undefined ? { lotDate: m.lotDate } : {}),
    ...(m.lotLabel !== undefined ? { lotLabel: m.lotLabel } : {}),
    quantity: m.quantity,
    reason,
    reversalOf: m.id,
    meta: { origType: m.type },
  });
}

export interface AuditResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly issues: readonly InventoryIssue[];
}

/** 検査: 取引の形と保存則（品番ごとに 預かり＋調整用 ＝ 在庫の外から入った数 − 外へ出た数） */
export function audit(movements: readonly Movement[]): AuditResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const m of movements) {
    if (ids.has(m.id)) errors.push(`取引IDの重複 ${m.id}`);
    ids.add(m.id);
    if (!isInt(m.quantity) || m.quantity <= 0) errors.push(`数量が正の整数でない ${m.id} ${String(m.quantity)}`);
    if ((m.fromBucket === 'LOT' || m.toBucket === 'LOT') && !m.lotKey) errors.push(`ロットがない ${m.id}`);
    if (m.fromBucket === m.toBucket) errors.push(`出と入りが同じ ${m.id}`);
  }
  const r = replay(movements);
  const outside: Record<string, number> = {};
  const inside = (b: Bucket): boolean => b === 'LOT' || b === 'ADJ';
  for (const m of movements) {
    if (!inside(m.fromBucket) && inside(m.toBucket)) outside[m.productId] = (outside[m.productId] ?? 0) + m.quantity;
    if (inside(m.fromBucket) && !inside(m.toBucket)) outside[m.productId] = (outside[m.productId] ?? 0) - m.quantity;
  }
  for (const [pid, b] of Object.entries(r.balances)) {
    if ((outside[pid] ?? 0) !== b.deposit + b.adjust) errors.push(`保存則が合わない ${pid}: 外との出入り ${outside[pid] ?? 0} ／ 残高 ${b.deposit + b.adjust}`);
  }
  // 保存則は「取り消された取引と取消しの対」を含めた全記録で成立する（対は互いに打ち消す）
  for (const m of movements.filter((x) => x.reversalOf)) {
    const o = movements.find((x) => x.id === m.reversalOf);
    if (!o) errors.push(`取消し元がない ${m.id}`);
    else if (o.quantity !== m.quantity || o.fromBucket !== m.toBucket || o.toBucket !== m.fromBucket || o.lotKey !== m.lotKey) errors.push(`取消しが元と対にならない ${m.id}`);
  }
  if (movements.filter((x) => x.reversalOf).length !== reversedIds(movements).size) errors.push('同じ取引を2回取り消している');
  return { ok: errors.length === 0, errors, issues: r.issues };
}

/** 登録前の確認: 取引を足したときに新しく出る問題点 */
export function previewIssues(movements: readonly Movement[], planned: readonly PlannedMovement[]): { issues: InventoryIssue[]; after: ProductBalance | undefined } {
  const maxSeq = movements.reduce((a, m) => Math.max(a, m.seq), 0);
  const added: Movement[] = planned.map((p, i) => ({ ...p, id: `preview-${i + 1}`, seq: maxSeq + i + 1 }));
  const before = new Set(replay(movements).issues.map((x) => `${x.kind}|${x.movementId}`));
  const r = replay([...movements, ...added]);
  const pid = planned[0]?.productId;
  return { issues: r.issues.filter((x) => !before.has(`${x.kind}|${x.movementId}`)), after: pid ? r.balances[pid] : undefined };
}

// ---- 在庫集計表 ----

export type CountBy = 'INSPECTION_MONTH' | 'DELIVERY_MONTH';

export interface MonthRow {
  readonly date: string;
  readonly inMonth: boolean;
  readonly lotNo: string;
  readonly prevAdjust: number | null;
  readonly takeBack: number | null;
  readonly selected: number | null;
  readonly ngBy: Readonly<Record<string, number>>;
  readonly ngTotal: number;
  readonly ngUnknown: number;
  readonly delivered: number | null;
  readonly endAdjust: number | null;
  readonly replenish: number;
  readonly boxDifference: number;
  readonly stocktake: number;
  readonly writer: string;
  readonly hours: number | null;
}

export interface MonthTotals {
  readonly openAdjust: number;
  readonly closeAdjust: number;
  readonly closeDeposit: number;
  readonly takeBack: number;
  readonly selected: number;
  readonly ngTotal: number;
  readonly ngBy: Readonly<Record<string, number>>;
  readonly delivered: number;
}

export function prevDay(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
}

/** 在庫集計表（現行の「集計表（現場用）」の欄）。月の各日と、その月の検品分を納入した翌月の日の行 */
export function monthSheet(movements: readonly Movement[], productId: string, month: string, countBy: CountBy = 'INSPECTION_MONTH'): { rows: MonthRow[]; totals: MonthTotals } {
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const first = `${month}-01`;
  const last = `${month}-${String(days).padStart(2, '0')}`;
  const all = movements.filter((m) => m.productId === productId);
  const L = liveMovements(all);
  const lotMonth = (m: Movement): string => (m.lotDate ?? m.businessDate).slice(0, 7);
  const dates = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const nextDel = L.filter((m) => m.type === 'DELIVERY' && m.businessDate > last && lotMonth(m) === month).map((m) => m.businessDate).sort();
  const extra = countBy === 'INSPECTION_MONTH' ? [...new Set(nextDel)].slice(0, 1) : [];
  const adjAt = (d: string, endOfDay: boolean): number => balanceOf(all, productId, endOfDay ? d : prevDay(d)).adjust;
  const rows: MonthRow[] = [...dates, ...extra].map((d) => {
    const inMonth = d <= last;
    const day = L.filter((m) => m.businessDate === d && (inMonth || m.type === 'DELIVERY'));
    const ins = day.filter((m) => m.type === 'INSPECT');
    const ngm = day.filter((m) => m.type === 'NG');
    const actual = ins.reduce((a, m) => a + (m.meta.actual ?? 0), 0);
    const ngBy: Record<string, number> = {};
    for (const m of ins) for (const [k, v] of Object.entries(m.meta.ngBy ?? {})) ngBy[k] = (ngBy[k] ?? 0) + v;
    const ngTotal = ngm.reduce((a, m) => a + m.quantity, 0);
    const dlv = day.filter((m) => m.type === 'DELIVERY' && (countBy === 'DELIVERY_MONTH' || lotMonth(m) === month)).reduce((a, m) => a + m.quantity, 0);
    const rep = day.filter((m) => m.type === 'REPLENISH').reduce((a, m) => a + m.quantity, 0);
    const boxDifference = day.filter((m) => m.type === 'FILL' || m.type === 'SURPLUS').reduce((a, m) => a + (m.meta.boxDifference ?? 0), 0);
    const st = day.filter((m) => m.type === 'STOCKTAKE').length;
    const hours = ins.reduce((a, m) => a + (m.meta.hours ?? 0), 0);
    return {
      date: d,
      inMonth,
      lotNo: ins.map((m) => m.meta.lotNo).filter((x): x is string => !!x).join('・'),
      prevAdjust: inMonth && (actual || dlv || rep) ? adjAt(d, false) : null,
      takeBack: actual || null,
      selected: actual || null,
      ngBy,
      ngTotal,
      ngUnknown: ngTotal - Object.values(ngBy).reduce((a, b) => a + b, 0),
      delivered: dlv || null,
      endAdjust: inMonth && (actual || dlv || rep || st) ? adjAt(d, true) : null,
      replenish: rep,
      boxDifference,
      stocktake: st,
      writer: ins.map((m) => m.meta.writer).filter((x): x is string => !!x).join('・'),
      hours: hours || null,
    };
  });
  const sum = (k: 'takeBack' | 'selected' | 'ngTotal' | 'delivered'): number => rows.filter((r) => r.inMonth || k === 'delivered').reduce((a, r) => a + (r[k] ?? 0), 0);
  const ngSum: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.ngBy)) ngSum[k] = (ngSum[k] ?? 0) + v;
  const close = balanceOf(all, productId, last);
  return {
    rows,
    totals: { openAdjust: balanceOf(all, productId, prevDay(first)).adjust, closeAdjust: close.adjust, closeDeposit: close.deposit, takeBack: sum('takeBack'), selected: sum('selected'), ngTotal: sum('ngTotal'), ngBy: ngSum, delivered: sum('delivered') },
  };
}

/** 1時間あたり個数。作業時間が 0（または未入力）のときは空欄（null）。Excel の #DIV/0! を出さない */
export function perHour(quantity: number | null, hours: number | null): number | null {
  if (!quantity || !hours || hours <= 0) return null;
  return Math.round(quantity / hours);
}

// ---- 品番ごとの設定 ----

export interface InventoryProductConfig {
  readonly inventoryManaged: boolean;
  readonly unitsPerBox: number | null;
  readonly adjustStockManaged: boolean;
  readonly adjustLowThreshold: number;
}

/** 調整用在庫が目安を下回るか（「預かり在庫から1箱回してください」の表示） */
export function adjustIsLow(balance: ProductBalance, config: InventoryProductConfig): boolean {
  return config.inventoryManaged && config.adjustStockManaged && balance.adjust < config.adjustLowThreshold;
}

/** 箱数の初期値＝選別数量÷入数（四捨五入） */
export function defaultBoxes(actual: number, unitsPerBox: number): number {
  return unitsPerBox > 0 ? Math.round(actual / unitsPerBox) : 0;
}

// ---- 作業日報の確定に伴う取引 ----

export interface ReportInventoryInput {
  readonly productId: string;
  readonly reportId: string;
  readonly revisionNo: number;
  /** 検品日＝日報の作業日 */
  readonly businessDate: string;
  readonly lotKey: string;
  readonly lotLabel: string;
  readonly actual: number;
  readonly defectTotal: number;
  readonly boxes: number;
  readonly unitsPerBox: number;
  readonly adjustManaged: boolean;
  /** この検品分から調整用に回す箱数（0 または省略で回さない） */
  readonly replenishBoxes?: number | undefined;
  readonly deliveredQuantity?: number | undefined;
  /** 納入日（納入数を入れたら必須。作業日とは別） */
  readonly deliveredDate?: string | undefined;
  readonly meta?: MovementMeta | undefined;
}

/**
 * 日報の確定（再確定を含む）の取引。①この日報の前の版が作った取引を取り消し → ②検品・不良・補充・余り → ③1箱回す → ④納入（古いロットから）。
 * 取消しは元の取引と同じ業務日・同じロットに戻す。納入の引当は、①〜③を反映した状態で行う。
 */
export function planReportInventory(existing: readonly Movement[], i: ReportInventoryInput): PlannedMovement[] {
  const out: PlannedMovement[] = [];
  const reversed = reversedIds(existing);
  for (const m of existing) {
    if (m.type === 'REVERSAL' || reversed.has(m.id)) continue;
    if (m.meta.reportId === i.reportId) out.push(planReversal(m, `日報の修正（版 ${i.revisionNo}）`));
  }
  const tag = (p: PlannedMovement): PlannedMovement => ({ ...p, meta: { ...p.meta, reportId: i.reportId, revisionNo: i.revisionNo } });
  const inspected = planInspection({ productId: i.productId, businessDate: i.businessDate, lotKey: i.lotKey, lotLabel: i.lotLabel, actual: i.actual, defectTotal: i.defectTotal, boxes: i.boxes, unitsPerBox: i.unitsPerBox, adjustManaged: i.adjustManaged, ...(i.meta ? { meta: i.meta } : {}) });
  out.push(...inspected.map(tag));
  const rep = i.replenishBoxes ?? 0;
  if (rep > 0) {
    if (!i.adjustManaged) throw new InventoryInputError('この品番は調整用在庫を管理していません。');
    out.push(...planReplenish({ productId: i.productId, businessDate: i.businessDate, lotKey: i.lotKey, lotDate: i.businessDate, lotLabel: i.lotLabel, quantity: rep * i.unitsPerBox, reason: '日報の「1箱回す」' }).map(tag));
  }
  const dq = i.deliveredQuantity ?? 0;
  if (dq > 0) {
    if (!i.deliveredDate) throw new InventoryInputError('納入数を入力したときは納入日が必要です。');
    // ①〜③の取引を反映した状態で引き当てる（仮の id・登録順を付ける）
    const base = existing.reduce((a, m) => Math.max(a, m.seq), 0);
    const sim: Movement[] = [...existing, ...out.map((p, n) => ({ ...p, id: `sim-${n + 1}`, seq: base + n + 1 }))];
    out.push(...planDelivery({ productId: i.productId, businessDate: i.deliveredDate, allocations: allocateFifo(sim, i.productId, i.deliveredDate, dq), reason: '日報の納入' }).map(tag));
  }
  return out;
}
