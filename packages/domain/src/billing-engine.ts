/**
 * 請求計算エンジン（請求・運搬費計算完全仕様書 v5.1 / CHG-009）。入力（承認済み実績の現在版・単価/運搬/固定費ルール・品番）
 * から請求明細・警告・小計・税・合計を作る純粋関数。DB・現在のマスタは参照しない（入力が snapshot）。
 *
 *  作業: 単価ルールは 品番＋作業内容＋作業日 で厳密に1件（作業内容が一致するルールを優先し、無ければ「全作業」= workTypeId null）。
 *        0件 RULE_NOT_FOUND、複数 RULE_AMBIGUOUS（明細を作らない）。
 *        QUANTITY: 数量×単価。TIME: 通常人分/60×単価 と 割増人分/60×単価×割増倍率 を別明細にし、明細ごとに四捨五入（ROUND_HALF_UP）
 *  運搬: 品番ごとに運搬ルール（運搬日で1件。作業内容なしのルールを優先）。
 *        PER_TRIP: 金額×運搬回数。NONE: 0（明細なし）。MONTHLY_FIXED: 期間に1回（下記）。
 *        ALLOCATED: 按分対象（GAP-016: 運搬ルールが ALLOCATED の品番＝allocation_eligible）。
 *          運搬費（運搬報告1件に1金額、CHG-004 D2）が入力済みなら、その金額を対象 distinct 品番で按分（q=floor(fee/n)、余り r を品番コード昇順の先頭 r 件へ +1）。
 *          未入力なら 按分グループごとにルール金額（1便の額）を按分し、運搬回数を掛ける。グループ内で金額が異なれば RULE_AMBIGUOUS。
 *        運搬費が入力済みで按分対象が無い → NO_ALLOCATION_TARGET。
 *  期間に1回: 月額固定の運搬ルール・固定費ルールは、お客様の品番で請求期間に重なる有効なルールを1明細。同じ品番（固定費は費目）に複数重なれば RULE_AMBIGUOUS。
 *  税: tax=ROUND_HALF_UP(小計×税率)、合計=小計+税。合計が負なら NEGATIVE_INVOICE。
 *  調整（CHG-011、遅延訂正 FR-019）: 確定済みの請求書への訂正額を、次の請求期間の明細（ADJUSTMENT、元の請求書番号付き）にする。負も可
 */
import Decimal from 'decimal.js';
import { allocateTransportFee } from './transport-allocation';
import { calculateTax } from './tax';
import { roundHalfUpToYen } from './money';
import { inRange, rangesOverlap } from './billing-period';

export const BILLING_ALGORITHM_VERSION = 'BILL-2026-09-05';
export const BILLING_TAX_RATE = '0.10';

export type SettlementType = 'QUANTITY' | 'TIME';
export type TransportType = 'ALLOCATED' | 'PER_TRIP' | 'MONTHLY_FIXED' | 'NONE';

export interface EngineProduct {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly settlementType: SettlementType;
}

export interface EngineRateRule {
  readonly id: string;
  readonly productId: string;
  readonly workTypeId: string | null;
  readonly unitPrice: string;
  readonly overtimeMultiplier: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface EngineTransportRule {
  readonly id: string;
  readonly productId: string;
  readonly workTypeId: string | null;
  readonly transportType: TransportType;
  readonly amountYen: number;
  readonly allocationGroup: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface EngineFixedCharge {
  readonly id: string;
  readonly productId: string;
  readonly label: string;
  readonly amountYen: number;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface EngineWorkSource {
  readonly reportId: string;
  readonly reportNo: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly businessDate: string;
  readonly productId: string;
  readonly workTypeId: string;
  readonly workTypeName: string;
  readonly quantity: number;
  readonly regularPersonMinutes: number;
  readonly overtimePersonMinutes: number;
}

export interface EngineDeliverySource {
  readonly reportId: string;
  readonly reportNo: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly businessDate: string;
  readonly tripCount: number;
  /** 運搬費（運搬報告1件に1金額、未入力は null） */
  readonly deliveryFeeYen: number | null;
  readonly items: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>;
}

/** 遅延訂正の調整（CHG-011）。確定済みの請求書を変えず、次の請求で差額を明細にする */
export interface EngineAdjustment {
  readonly id: string;
  readonly productId: string;
  readonly description: string;
  /** 0 以外の整数円（負は値引き・返金） */
  readonly amountYen: number;
  readonly sourceInvoiceNo: string;
  readonly sourceReportNo: string | null;
}

export interface BillingEngineInput {
  readonly customerId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly taxRate?: string;
  /** お客様の品番（実績の品番と期間ルールの対象） */
  readonly products: readonly EngineProduct[];
  /** 有効なルールだけを渡す */
  readonly rateRules: readonly EngineRateRule[];
  readonly transportRules: readonly EngineTransportRule[];
  readonly fixedCharges: readonly EngineFixedCharge[];
  readonly work: readonly EngineWorkSource[];
  readonly deliveries: readonly EngineDeliverySource[];
  /** CHG-011: この請求に入れる調整（未適用のもの） */
  readonly adjustments?: readonly EngineAdjustment[];
}

export type BillingLineType = 'WORK_QUANTITY' | 'WORK_REGULAR' | 'WORK_OVERTIME' | 'TRANSPORT_PER_TRIP' | 'TRANSPORT_ALLOCATED' | 'TRANSPORT_MONTHLY' | 'FIXED_CHARGE' | 'ADJUSTMENT';
export type BillingSourceType = 'WORK' | 'DELIVERY' | 'RULE' | 'ADJUSTMENT';
export type BillingWarningCode = 'RULE_NOT_FOUND' | 'RULE_AMBIGUOUS' | 'NO_ALLOCATION_TARGET' | 'NEGATIVE_INVOICE';

export interface BillingLine {
  readonly no: number;
  readonly lineType: BillingLineType;
  readonly sourceType: BillingSourceType;
  readonly reportId: string | null;
  readonly reportNo: string | null;
  readonly revisionId: string | null;
  readonly revisionNo: number | null;
  readonly businessDate: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly description: string;
  /** 数量（個・人時・便・件・月）。10進文字列 */
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly multiplier: string | null;
  /** 四捨五入前の金額（10進文字列） */
  readonly unrounded: string;
  readonly amountYen: number;
  readonly ruleId: string;
  readonly ruleSnapshot: Readonly<Record<string, unknown>>;
  readonly calculation: Readonly<Record<string, unknown>>;
}

export interface BillingWarning {
  /** run 内で一意・再計算しても同じ根拠なら同じ ID */
  readonly id: string;
  readonly code: BillingWarningCode;
  readonly sourceType: BillingSourceType;
  readonly reportId: string | null;
  readonly reportNo: string | null;
  readonly revisionId: string | null;
  readonly businessDate: string | null;
  readonly productId: string | null;
  readonly productCode: string | null;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface BillingTotals {
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
}

export interface BillingEngineResult extends BillingTotals {
  readonly algorithmVersion: string;
  readonly customerId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly lines: readonly BillingLine[];
  readonly warnings: readonly BillingWarning[];
  /** 計算に使った実績（報告ID・版）。確定時に現在版と一致するかを確認する */
  readonly sources: ReadonlyArray<{ readonly type: 'WORK' | 'DELIVERY'; readonly reportId: string; readonly revisionId: string }>;
  readonly ruleIds: readonly string[];
  /** CHG-011: 明細に入れた調整の ID。確定時に未適用のままかを照合する */
  readonly adjustmentIds: readonly string[];
}

type Draft = Omit<BillingLine, 'no'>;

const LINE_ORDER: Record<BillingLineType, number> = {
  WORK_QUANTITY: 0,
  WORK_REGULAR: 1,
  WORK_OVERTIME: 2,
  TRANSPORT_PER_TRIP: 3,
  TRANSPORT_ALLOCATED: 4,
  TRANSPORT_MONTHLY: 5,
  FIXED_CHARGE: 6,
  ADJUSTMENT: 7,
};

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);
const yen = (n: number): string => `${n.toLocaleString('ja-JP')}円`;

/** 作業内容が一致するルールを優先し、無ければ作業内容なし（全作業）のルール */
function pick<T extends { readonly workTypeId: string | null; readonly validFrom: string; readonly validTo: string | null; readonly productId: string }>(
  rules: readonly T[],
  productId: string,
  workTypeId: string | null,
  date: string,
): T[] {
  const onDate = rules.filter((r) => r.productId === productId && inRange(date, r.validFrom, r.validTo));
  const exact = workTypeId === null ? [] : onDate.filter((r) => r.workTypeId === workTypeId);
  if (exact.length > 0) return exact;
  const wildcard = onDate.filter((r) => r.workTypeId === null);
  if (wildcard.length > 0) return wildcard;
  return workTypeId === null ? onDate : [];
}

function sortLines(lines: Draft[]): BillingLine[] {
  return [...lines]
    .sort(
      (a, b) =>
        cmp(a.businessDate ?? '9999-99-99', b.businessDate ?? '9999-99-99') ||
        cmp(a.reportNo ?? '', b.reportNo ?? '') ||
        cmp(LINE_ORDER[a.lineType], LINE_ORDER[b.lineType]) ||
        cmp(a.productCode, b.productCode) ||
        cmp(a.description, b.description) ||
        cmp(a.ruleId, b.ruleId),
    )
    .map((l, i) => ({ no: i + 1, ...l }));
}

/** 明細の合計と税（除外した報告の明細は数えない） */
export function totalsOf(lines: readonly Pick<BillingLine, 'amountYen' | 'reportId'>[], taxRate: string = BILLING_TAX_RATE, excludedReportIds: ReadonlySet<string> = new Set()): BillingTotals {
  const subtotalYen = lines.filter((l) => l.reportId === null || !excludedReportIds.has(l.reportId)).reduce((s, l) => s + l.amountYen, 0);
  const { taxYen, totalYen } = calculateTax({ subtotalYen, taxRate });
  return { subtotalYen, taxYen, totalYen, taxRate };
}

export function calculateBilling(input: BillingEngineInput): BillingEngineResult {
  const taxRate = input.taxRate ?? BILLING_TAX_RATE;
  const products = new Map(input.products.map((p) => [p.id, p]));
  const lines: Draft[] = [];
  const warnings = new Map<string, BillingWarning>();
  const usedRules = new Set<string>();
  const productOf = (id: string): EngineProduct => products.get(id) ?? { id, code: id, name: '（不明な品番）', settlementType: 'QUANTITY' };

  const warn = (w: Omit<BillingWarning, 'id'>): void => {
    const id = [w.code, w.reportId ?? '-', w.productId ?? '-', String(w.detail['key'] ?? '')].join(':');
    if (!warnings.has(id)) warnings.set(id, { id, ...w });
  };

  // ---------------- 作業 ----------------
  const work = [...input.work].sort((a, b) => cmp(a.businessDate, b.businessDate) || cmp(a.reportNo, b.reportNo));
  for (const w of work) {
    const p = productOf(w.productId);
    const src = { sourceType: 'WORK' as const, reportId: w.reportId, reportNo: w.reportNo, revisionId: w.revisionId, businessDate: w.businessDate, productId: p.id, productCode: p.code };
    const found = pick(input.rateRules, w.productId, w.workTypeId, w.businessDate);
    if (found.length !== 1) {
      warn({
        ...src,
        code: found.length === 0 ? 'RULE_NOT_FOUND' : 'RULE_AMBIGUOUS',
        message: `${found.length === 0 ? '単価ルールがありません' : '単価ルールが複数該当します'}（${p.code} / ${w.workTypeName} / ${w.businessDate}）`,
        detail: { key: 'rate', ruleType: 'rates', workTypeId: w.workTypeId, ruleIds: found.map((r) => r.id).sort() },
      });
      continue;
    }
    const rule = found[0] as EngineRateRule;
    usedRules.add(rule.id);
    const ruleSnapshot = { type: 'rates', ...rule };
    const base = { ...src, revisionNo: w.revisionNo, ruleId: rule.id, ruleSnapshot };
    const unitPrice = new Decimal(rule.unitPrice);
    if (p.settlementType === 'QUANTITY') {
      const raw = new Decimal(w.quantity).times(unitPrice);
      lines.push({
        ...base,
        lineType: 'WORK_QUANTITY',
        description: `${p.code} ${p.name} / ${w.workTypeName}`,
        quantity: String(w.quantity),
        unit: '個',
        unitPrice: unitPrice.toString(),
        multiplier: null,
        unrounded: raw.toString(),
        amountYen: roundHalfUpToYen(raw),
        calculation: { settlementType: 'QUANTITY', formula: 'quantity*unitPrice', quantity: w.quantity, unitPrice: unitPrice.toString() },
      });
      continue;
    }
    const parts: Array<{ type: 'WORK_REGULAR' | 'WORK_OVERTIME'; minutes: number; multiplier: Decimal; label: string }> = [
      { type: 'WORK_REGULAR', minutes: w.regularPersonMinutes, multiplier: new Decimal(1), label: '通常' },
      { type: 'WORK_OVERTIME', minutes: w.overtimePersonMinutes, multiplier: new Decimal(rule.overtimeMultiplier), label: '割増' },
    ];
    for (const part of parts) {
      if (part.minutes <= 0) continue;
      const hours = new Decimal(part.minutes).dividedBy(60);
      const raw = hours.times(unitPrice).times(part.multiplier);
      lines.push({
        ...base,
        lineType: part.type,
        description: `${p.code} ${p.name} / ${w.workTypeName}（${part.label}）`,
        quantity: hours.toDecimalPlaces(4).toString(),
        unit: '人時',
        unitPrice: unitPrice.toString(),
        multiplier: part.multiplier.toString(),
        unrounded: raw.toString(),
        amountYen: roundHalfUpToYen(raw),
        calculation: { settlementType: 'TIME', formula: 'personMinutes/60*unitPrice*multiplier', personMinutes: part.minutes, unitPrice: unitPrice.toString(), multiplier: part.multiplier.toString() },
      });
    }
  }

  // ---------------- 運搬 ----------------
  const deliveries = [...input.deliveries].sort((a, b) => cmp(a.businessDate, b.businessDate) || cmp(a.reportNo, b.reportNo));
  for (const d of deliveries) {
    const ids = [...new Set(d.items.map((i) => i.productId))].map(productOf).sort((a, b) => cmp(a.code, b.code));
    const src = { sourceType: 'DELIVERY' as const, reportId: d.reportId, reportNo: d.reportNo, revisionId: d.revisionId, businessDate: d.businessDate };
    const eligible: Array<{ p: EngineProduct; rule: EngineTransportRule }> = [];
    for (const p of ids) {
      const found = pick(input.transportRules, p.id, null, d.businessDate);
      if (found.length !== 1) {
        warn({
          ...src,
          productId: p.id,
          productCode: p.code,
          code: found.length === 0 ? 'RULE_NOT_FOUND' : 'RULE_AMBIGUOUS',
          message: `${found.length === 0 ? '運搬ルールがありません' : '運搬ルールが複数該当します'}（${p.code} / ${d.businessDate}）`,
          detail: { key: 'transport', ruleType: 'transport-rules', ruleIds: found.map((r) => r.id).sort() },
        });
        continue;
      }
      const rule = found[0] as EngineTransportRule;
      if (rule.transportType === 'PER_TRIP') {
        usedRules.add(rule.id);
        const amount = rule.amountYen * d.tripCount;
        lines.push({
          ...src,
          revisionNo: d.revisionNo,
          productId: p.id,
          productCode: p.code,
          lineType: 'TRANSPORT_PER_TRIP',
          description: `運搬（便ごと） ${p.code} ${p.name}`,
          quantity: String(d.tripCount),
          unit: '便',
          unitPrice: String(rule.amountYen),
          multiplier: null,
          unrounded: String(amount),
          amountYen: amount,
          ruleId: rule.id,
          ruleSnapshot: { type: 'transport-rules', ...rule },
          calculation: { transportType: 'PER_TRIP', formula: 'amountYen*tripCount', amountYen: rule.amountYen, tripCount: d.tripCount },
        });
      } else if (rule.transportType === 'ALLOCATED') {
        eligible.push({ p, rule });
      } else {
        // NONE は 0、MONTHLY_FIXED は期間に1回（下で作る）
        usedRules.add(rule.id);
      }
    }
    if (eligible.length === 0) {
      if (d.deliveryFeeYen !== null && d.deliveryFeeYen > 0) {
        warn({
          ...src,
          productId: null,
          productCode: null,
          code: 'NO_ALLOCATION_TARGET',
          message: `按分対象の品番がありません（${d.reportNo} / ${d.businessDate} / 運搬費 ${yen(d.deliveryFeeYen)}）`,
          detail: { key: 'allocation', deliveryFeeYen: d.deliveryFeeYen, productIds: ids.map((p) => p.id) },
        });
      }
      continue;
    }
    const pushAllocated = (group: Array<{ p: EngineProduct; rule: EngineTransportRule }>, feeYen: number, trips: number, feeSource: 'REPORT' | 'RULE'): void => {
      const alloc = allocateTransportFee({ feeYen, productCodes: group.map((g) => g.p.code) });
      for (const g of group) {
        usedRules.add(g.rule.id);
        const share = alloc.amounts[g.p.code] ?? 0;
        const amount = share * trips;
        lines.push({
          ...src,
          revisionNo: d.revisionNo,
          productId: g.p.id,
          productCode: g.p.code,
          lineType: 'TRANSPORT_ALLOCATED',
          description: `運搬按分 ${g.p.code} ${g.p.name}（${yen(feeYen)} ÷ ${alloc.distinctCount}品番${feeSource === 'RULE' ? ` × ${trips}便` : ''}）`,
          quantity: String(trips),
          unit: feeSource === 'RULE' ? '便' : '件',
          unitPrice: String(share),
          multiplier: null,
          unrounded: String(amount),
          amountYen: amount,
          ruleId: g.rule.id,
          ruleSnapshot: { type: 'transport-rules', ...g.rule },
          calculation: {
            transportType: 'ALLOCATED',
            feeSource,
            feeYen,
            distinctCount: alloc.distinctCount,
            share,
            trips,
            formula: 'q=floor(fee/n), r=fee-q*n, 品番コード昇順の先頭r件へ+1',
          },
        });
      }
    };
    if (d.deliveryFeeYen !== null) {
      // 運搬費（運搬報告1件に1金額）を按分元にする
      pushAllocated(eligible, d.deliveryFeeYen, 1, 'REPORT');
      continue;
    }
    const groups = new Map<string, Array<{ p: EngineProduct; rule: EngineTransportRule }>>();
    for (const e of eligible) {
      const key = e.rule.allocationGroup ?? '';
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const [key, group] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const amounts = [...new Set(group.map((g) => g.rule.amountYen))];
      if (amounts.length !== 1) {
        warn({
          ...src,
          productId: null,
          productCode: null,
          code: 'RULE_AMBIGUOUS',
          message: `按分グループ内で運搬ルールの金額が異なります（${d.reportNo} / ${key === '' ? 'グループなし' : key}）`,
          detail: { key: `allocation-group:${key}`, ruleType: 'transport-rules', ruleIds: group.map((g) => g.rule.id).sort(), amounts: amounts.sort((a, b) => a - b) },
        });
        continue;
      }
      pushAllocated(group, amounts[0] as number, d.tripCount, 'RULE');
    }
  }

  // ---------------- 期間に1回（月額固定の運搬・固定費） ----------------
  const period = { from: input.periodStart, to: input.periodEnd };
  const customerProducts = [...input.products].sort((a, b) => cmp(a.code, b.code));
  for (const p of customerProducts) {
    const monthly = input.transportRules.filter((r) => r.productId === p.id && r.transportType === 'MONTHLY_FIXED' && rangesOverlap(period, { from: r.validFrom, to: r.validTo }));
    if (monthly.length > 1) {
      warn({
        sourceType: 'RULE', reportId: null, reportNo: null, revisionId: null, businessDate: null, productId: p.id, productCode: p.code,
        code: 'RULE_AMBIGUOUS',
        message: `月額固定の運搬ルールが請求期間に複数あります（${p.code}）`,
        detail: { key: 'monthly', ruleType: 'transport-rules', ruleIds: monthly.map((r) => r.id).sort() },
      });
    } else if (monthly.length === 1) {
      const rule = monthly[0] as EngineTransportRule;
      usedRules.add(rule.id);
      lines.push({
        sourceType: 'RULE', reportId: null, reportNo: null, revisionId: null, revisionNo: null, businessDate: null, productId: p.id, productCode: p.code,
        lineType: 'TRANSPORT_MONTHLY',
        description: `運搬（月額固定） ${p.code} ${p.name}`,
        quantity: '1',
        unit: '月',
        unitPrice: String(rule.amountYen),
        multiplier: null,
        unrounded: String(rule.amountYen),
        amountYen: rule.amountYen,
        ruleId: rule.id,
        ruleSnapshot: { type: 'transport-rules', ...rule },
        calculation: { transportType: 'MONTHLY_FIXED', formula: 'amountYen（請求期間に1回）', amountYen: rule.amountYen },
      });
    }
    const fixed = input.fixedCharges.filter((r) => r.productId === p.id && rangesOverlap(period, { from: r.validFrom, to: r.validTo }));
    const labels = [...new Set(fixed.map((f) => f.label))].sort(cmp);
    for (const label of labels) {
      const same = fixed.filter((f) => f.label === label);
      if (same.length > 1) {
        warn({
          sourceType: 'RULE', reportId: null, reportNo: null, revisionId: null, businessDate: null, productId: p.id, productCode: p.code,
          code: 'RULE_AMBIGUOUS',
          message: `固定費ルールが請求期間に複数あります（${p.code} / ${label}）`,
          detail: { key: `fixed:${label}`, ruleType: 'fixed-charges', ruleIds: same.map((r) => r.id).sort() },
        });
        continue;
      }
      const rule = same[0] as EngineFixedCharge;
      usedRules.add(rule.id);
      lines.push({
        sourceType: 'RULE', reportId: null, reportNo: null, revisionId: null, revisionNo: null, businessDate: null, productId: p.id, productCode: p.code,
        lineType: 'FIXED_CHARGE',
        description: `${label} ${p.code} ${p.name}`,
        quantity: '1',
        unit: '式',
        unitPrice: String(rule.amountYen),
        multiplier: null,
        unrounded: String(rule.amountYen),
        amountYen: rule.amountYen,
        ruleId: rule.id,
        ruleSnapshot: { type: 'fixed-charges', ...rule },
        calculation: { formula: 'amountYen（請求期間に1回）', amountYen: rule.amountYen },
      });
    }
  }

  // ---------------- 調整（CHG-011） ----------------
  const adjustments = [...(input.adjustments ?? [])].sort((a, b) => cmp(a.sourceInvoiceNo, b.sourceInvoiceNo) || cmp(a.id, b.id));
  for (const a of adjustments) {
    const p = productOf(a.productId);
    lines.push({
      sourceType: 'ADJUSTMENT', reportId: null, reportNo: a.sourceReportNo, revisionId: null, revisionNo: null, businessDate: null, productId: p.id, productCode: p.code,
      lineType: 'ADJUSTMENT',
      description: `調整 ${a.description}（${a.sourceInvoiceNo} の訂正）`,
      quantity: '1',
      unit: '式',
      unitPrice: String(a.amountYen),
      multiplier: null,
      unrounded: String(a.amountYen),
      amountYen: a.amountYen,
      ruleId: a.id,
      ruleSnapshot: { type: 'adjustment', ...a },
      calculation: { formula: '調整額（確定済みの請求書の訂正を次の請求に反映）', amountYen: a.amountYen, sourceInvoiceNo: a.sourceInvoiceNo, sourceReportNo: a.sourceReportNo },
    });
  }

  const sorted = sortLines(lines);
  const totals = totalsOf(sorted, taxRate);
  if (totals.totalYen < 0) {
    warn({
      sourceType: 'RULE', reportId: null, reportNo: null, revisionId: null, businessDate: null, productId: null, productCode: null,
      code: 'NEGATIVE_INVOICE',
      message: `請求合計が負です（${yen(totals.totalYen)}）`,
      detail: { key: 'total', totalYen: totals.totalYen },
    });
  }
  const sources = [
    ...work.map((w) => ({ type: 'WORK' as const, reportId: w.reportId, revisionId: w.revisionId })),
    ...deliveries.map((d) => ({ type: 'DELIVERY' as const, reportId: d.reportId, revisionId: d.revisionId })),
  ];
  return {
    algorithmVersion: BILLING_ALGORITHM_VERSION,
    customerId: input.customerId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines: sorted,
    warnings: [...warnings.values()].sort((a, b) => cmp(a.businessDate ?? '9999', b.businessDate ?? '9999') || cmp(a.reportNo ?? '', b.reportNo ?? '') || cmp(a.id, b.id)),
    sources,
    ruleIds: [...usedRules].sort(cmp),
    adjustmentIds: adjustments.map((a) => a.id),
    ...totals,
  };
}

/** キー順を正規化した JSON（hash 用: key 昇順・空白なし・undefined を除く） */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => cmp(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
