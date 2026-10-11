import { describe, it, expect } from 'vitest';
import golden from '../../../billing-golden.json';
import {
  BILLING_ALGORITHM_VERSION,
  calculateBilling,
  canonicalJson,
  totalsOf,
  type BillingEngineInput,
  type EngineDeliverySource,
  type EngineProduct,
  type EngineRateRule,
  type EngineTransportRule,
  type EngineWorkSource,
} from './billing-engine';

type Case = { id: string; input: Record<string, unknown>; expected: Record<string, unknown> };
const cases = golden.cases as Case[];
const gold = (id: string): Case => cases.find((c) => c.id === id) as Case;

const P = (id: string, code: string, settlementType: 'QUANTITY' | 'TIME' = 'QUANTITY'): EngineProduct => ({ id, code, name: `品${code}`, settlementType });
const rate = (id: string, productId: string, unitPrice: string, extra: Partial<EngineRateRule> = {}): EngineRateRule => ({
  id, productId, workTypeId: null, unitPrice, overtimeMultiplier: '1.25', validFrom: '2026-01-01', validTo: null, ...extra,
});
const tr = (id: string, productId: string, transportType: EngineTransportRule['transportType'], amountYen: number, extra: Partial<EngineTransportRule> = {}): EngineTransportRule => ({
  id, productId, workTypeId: null, transportType, amountYen, allocationGroup: null, validFrom: '2026-01-01', validTo: null, ...extra,
});
const work = (n: number, productId: string, extra: Partial<EngineWorkSource> = {}): EngineWorkSource => ({
  reportId: `wr-${n}`, reportNo: `WR-202609-${String(n).padStart(6, '0')}`, revisionId: `wr-${n}-r1`, revisionNo: 1, businessDate: '2026-09-07',
  productId, workTypeId: 'wt-1', workTypeName: '外観検査', quantity: 0, regularPersonMinutes: 0, overtimePersonMinutes: 0, ...extra,
});
const delivery = (n: number, productIds: string[], extra: Partial<EngineDeliverySource> = {}): EngineDeliverySource => ({
  reportId: `dr-${n}`, reportNo: `DR-202609-${String(n).padStart(6, '0')}`, revisionId: `dr-${n}-r1`, revisionNo: 1, businessDate: '2026-09-08',
  tripCount: 1, deliveryFeeYen: null, items: productIds.map((productId) => ({ productId, quantity: 10 })), ...extra,
});
const base = (over: Partial<BillingEngineInput>): BillingEngineInput => ({
  customerId: 'c-1', periodStart: '2026-09-01', periodEnd: '2026-09-30', products: [], rateRules: [], transportRules: [], fixedCharges: [], work: [], deliveries: [], ...over,
});

describe('calculateBilling: billing-golden を明細として再現', () => {
  it('algorithmVersion は golden と同じ', () => {
    expect(BILLING_ALGORITHM_VERSION).toBe(golden.algorithmVersion);
  });

  it('G-QTY-001 / G-ROUND-001: 数量×単価、明細ごとに四捨五入', () => {
    for (const id of ['G-QTY-001', 'G-ROUND-001']) {
      const g = gold(id);
      const r = calculateBilling(base({ products: [P('p', 'A')], rateRules: [rate('r', 'p', g.input['unitPrice'] as string)], work: [work(1, 'p', { quantity: g.input['quantity'] as number })] }));
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]?.amountYen).toBe(g.expected['amountYen']);
      expect(r.lines[0]).toMatchObject({ lineType: 'WORK_QUANTITY', unit: '個' });
    }
  });

  it('G-BILL-001: 通常と割増（×1.25）を別明細にして合計 6,930円', () => {
    const g = gold('G-BILL-001');
    const r = calculateBilling(
      base({
        products: [P('p', 'A', 'TIME')],
        rateRules: [rate('r', 'p', g.input['unitPrice'] as string, { overtimeMultiplier: g.input['multiplier'] as string })],
        work: [work(1, 'p', { regularPersonMinutes: g.input['regularPersonMinutes'] as number, overtimePersonMinutes: g.input['overtimePersonMinutes'] as number })],
      }),
    );
    expect(r.lines.map((l) => [l.lineType, l.unrounded, l.amountYen, l.multiplier])).toEqual([
      ['WORK_REGULAR', g.expected['regularRaw'], 1980, '1'],
      ['WORK_OVERTIME', g.expected['overtimeRaw'], 4950, '1.25'],
    ]);
    expect(r.subtotalYen).toBe(g.expected['amountYen']);
  });

  it('G-ALLOC-001〜003: 1便の額を対象 distinct 品番で按分（品番コード昇順の先頭へ余り）', () => {
    for (const id of ['G-ALLOC-001', 'G-ALLOC-002', 'G-ALLOC-003']) {
      const g = gold(id);
      const codes = g.input['productCodes'] as string[];
      const products = [...new Set(codes)].map((c) => P(`p${c}`, c));
      const r = calculateBilling(
        base({
          products,
          transportRules: products.map((p) => tr(`t${p.code}`, p.id, 'ALLOCATED', g.input['feeYen'] as number)),
          deliveries: [delivery(1, codes.map((c) => `p${c}`))],
        }),
      );
      const got = Object.fromEntries(r.lines.map((l) => [l.productCode, l.amountYen]));
      for (const [k, v] of Object.entries(g.expected)) {
        if (k === 'sum') expect(r.subtotalYen).toBe(v);
        else if (k === 'distinctCount') expect(r.lines).toHaveLength(v as number);
        else expect(got[k]).toBe(v);
      }
    }
  });

  it('G-TAX-001 / G-TAX-002: 税は小計×10% を四捨五入', () => {
    for (const id of ['G-TAX-001', 'G-TAX-002']) {
      const g = gold(id);
      const t = totalsOf([{ amountYen: g.input['subtotalYen'] as number, reportId: null }], g.input['taxRate'] as string);
      expect([t.taxYen, t.totalYen]).toEqual([g.expected['taxYen'], g.expected['totalYen']]);
    }
  });
});

describe('calculateBilling: 単価ルールの選択と警告', () => {
  it('作業内容が一致するルールを優先、無ければ全作業のルール', () => {
    const r = calculateBilling(
      base({
        products: [P('p', 'A')],
        rateRules: [rate('all', 'p', '1'), rate('wt', 'p', '2', { workTypeId: 'wt-1' })],
        work: [work(1, 'p', { quantity: 10 }), work(2, 'p', { quantity: 10, workTypeId: 'wt-2', workTypeName: '洗浄' })],
      }),
    );
    expect(r.lines.map((l) => [l.reportId, l.ruleId, l.amountYen])).toEqual([
      ['wr-1', 'wt', 20],
      ['wr-2', 'all', 10],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('適用期間外は RULE_NOT_FOUND、重なりは RULE_AMBIGUOUS（明細を作らない）', () => {
    const r = calculateBilling(
      base({
        products: [P('p', 'A'), P('q', 'B')],
        rateRules: [rate('old', 'p', '1', { validTo: '2026-08-31' }), rate('q1', 'q', '1'), rate('q2', 'q', '2')],
        work: [work(1, 'p', { quantity: 1 }), work(2, 'q', { quantity: 1 })],
      }),
    );
    expect(r.lines).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.reportId, w.productCode])).toEqual([
      ['RULE_NOT_FOUND', 'wr-1', 'A'],
      ['RULE_AMBIGUOUS', 'wr-2', 'B'],
    ]);
    expect(r.warnings[1]?.detail['ruleIds']).toEqual(['q1', 'q2']);
    expect(r.subtotalYen).toBe(0);
  });

  it('時間精算: 通常のみ・割増のみ・0分は明細なし', () => {
    const r = calculateBilling(
      base({
        products: [P('p', 'A', 'TIME')],
        rateRules: [rate('r', 'p', '1980')],
        work: [work(1, 'p', { regularPersonMinutes: 230 }), work(2, 'p', { overtimePersonMinutes: 120 }), work(3, 'p')],
      }),
    );
    expect(r.lines.map((l) => [l.reportId, l.lineType, l.quantity, l.amountYen])).toEqual([
      ['wr-1', 'WORK_REGULAR', '3.8333', 7590],
      ['wr-2', 'WORK_OVERTIME', '2', 4950],
    ]);
  });
});

describe('calculateBilling: 運搬', () => {
  const products = [P('pa', 'A'), P('pb', 'B'), P('pc', 'C')];

  it('PER_TRIP は金額×運搬回数、NONE は明細なし', () => {
    const r = calculateBilling(
      base({ products, transportRules: [tr('ta', 'pa', 'PER_TRIP', 1500), tr('tb', 'pb', 'NONE', 0)], deliveries: [delivery(1, ['pa', 'pb'], { tripCount: 3 })] }),
    );
    expect(r.lines.map((l) => [l.productCode, l.lineType, l.quantity, l.amountYen])).toEqual([['A', 'TRANSPORT_PER_TRIP', '3', 4500]]);
    expect(r.ruleIds).toEqual(['ta', 'tb']);
  });

  it('ALLOCATED: 運搬費が入力済みならその金額を按分（運搬回数は掛けない）', () => {
    const r = calculateBilling(
      base({ products, transportRules: products.map((p) => tr(`t${p.code}`, p.id, 'ALLOCATED', 2500)), deliveries: [delivery(1, ['pc', 'pa', 'pb', 'pa'], { tripCount: 2, deliveryFeeYen: 3001 })] }),
    );
    expect(r.lines.map((l) => [l.productCode, l.amountYen, l.calculation['feeSource']])).toEqual([
      ['A', 1001, 'REPORT'],
      ['B', 1000, 'REPORT'],
      ['C', 1000, 'REPORT'],
    ]);
    expect(r.subtotalYen).toBe(3001);
  });

  it('ALLOCATED: 運搬費が未入力ならルール金額（1便）を按分して運搬回数を掛ける。按分グループごと', () => {
    const r = calculateBilling(
      base({
        products,
        transportRules: [tr('ta', 'pa', 'ALLOCATED', 2500), tr('tb', 'pb', 'ALLOCATED', 2500), tr('tc', 'pc', 'ALLOCATED', 1000, { allocationGroup: 'G2' })],
        deliveries: [delivery(1, ['pa', 'pb', 'pc'], { tripCount: 2 })],
      }),
    );
    expect(r.lines.map((l) => [l.productCode, l.unitPrice, l.amountYen])).toEqual([
      ['A', '1250', 2500],
      ['B', '1250', 2500],
      ['C', '1000', 2000],
    ]);
  });

  it('ALLOCATED: 同じグループで金額が異なれば RULE_AMBIGUOUS', () => {
    const r = calculateBilling(base({ products, transportRules: [tr('ta', 'pa', 'ALLOCATED', 2500), tr('tb', 'pb', 'ALLOCATED', 2000)], deliveries: [delivery(1, ['pa', 'pb'])] }));
    expect(r.lines).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['RULE_AMBIGUOUS']);
  });

  it('運搬費が入力済みで按分対象が無ければ NO_ALLOCATION_TARGET、ルールが無い品番は RULE_NOT_FOUND', () => {
    const r = calculateBilling(base({ products, transportRules: [tr('ta', 'pa', 'NONE', 0)], deliveries: [delivery(7, ['pa', 'pb'], { deliveryFeeYen: 2500 })] }));
    expect(r.warnings.map((w) => [w.code, w.reportId, w.productCode])).toEqual([
      ['NO_ALLOCATION_TARGET', 'dr-7', null],
      ['RULE_NOT_FOUND', 'dr-7', 'B'],
    ]);
  });

  it('MONTHLY_FIXED と固定費は請求期間に1回（運搬が無くても）。期間に重なりが複数なら RULE_AMBIGUOUS', () => {
    const r = calculateBilling(
      base({
        products,
        transportRules: [tr('ma', 'pa', 'MONTHLY_FIXED', 30000), tr('mb1', 'pb', 'MONTHLY_FIXED', 1, { validTo: '2026-09-10' }), tr('mb2', 'pb', 'MONTHLY_FIXED', 2, { validFrom: '2026-09-11' })],
        fixedCharges: [
          { id: 'f1', productId: 'pc', label: '保管料', amountYen: 5000, validFrom: '2026-01-01', validTo: null },
          { id: 'f2', productId: 'pc', label: '旧費目', amountYen: 9, validFrom: '2026-01-01', validTo: '2026-08-31' },
        ],
        deliveries: [delivery(1, ['pa'])],
      }),
    );
    expect(r.lines.map((l) => [l.lineType, l.productCode, l.amountYen])).toEqual([
      ['TRANSPORT_MONTHLY', 'A', 30000],
      ['FIXED_CHARGE', 'C', 5000],
    ]);
    expect(r.warnings.map((w) => [w.code, w.productCode])).toEqual([['RULE_AMBIGUOUS', 'B']]);
  });
});

describe('calculateBilling: 並び・合計・再現性', () => {
  it('明細は 業務日→報告番号→区分→品番 の順で 1 から採番。sources に計算した版を返す', () => {
    const r = calculateBilling(
      base({
        products: [P('pa', 'A'), P('pb', 'B', 'TIME')],
        rateRules: [rate('ra', 'pa', '4.4'), rate('rb', 'pb', '1980')],
        transportRules: [tr('ta', 'pa', 'PER_TRIP', 1000)],
        work: [work(2, 'pb', { businessDate: '2026-09-05', regularPersonMinutes: 60, overtimePersonMinutes: 60 }), work(1, 'pa', { businessDate: '2026-09-09', quantity: 1600 })],
        deliveries: [delivery(1, ['pa'], { businessDate: '2026-09-05' })],
      }),
    );
    expect(r.lines.map((l) => [l.no, l.businessDate, l.reportNo, l.lineType])).toEqual([
      [1, '2026-09-05', 'DR-202609-000001', 'TRANSPORT_PER_TRIP'],
      [2, '2026-09-05', 'WR-202609-000002', 'WORK_REGULAR'],
      [3, '2026-09-05', 'WR-202609-000002', 'WORK_OVERTIME'],
      [4, '2026-09-09', 'WR-202609-000001', 'WORK_QUANTITY'],
    ]);
    expect(r.subtotalYen).toBe(1000 + 1980 + 2475 + 7040);
    expect(r.taxYen).toBe(1250);
    expect(r.totalYen).toBe(12495 + 1250);
    expect(r.sources).toEqual([
      { type: 'WORK', reportId: 'wr-2', revisionId: 'wr-2-r1' },
      { type: 'WORK', reportId: 'wr-1', revisionId: 'wr-1-r1' },
      { type: 'DELIVERY', reportId: 'dr-1', revisionId: 'dr-1-r1' },
    ]);
  });

  it('入力の順序が違っても結果（canonical JSON）は同じ', () => {
    const input = base({
      products: [P('pa', 'A'), P('pb', 'B')],
      rateRules: [rate('ra', 'pa', '3'), rate('rb', 'pb', '5')],
      work: [work(1, 'pa', { quantity: 3 }), work(2, 'pb', { quantity: 4 })],
    });
    const a = calculateBilling(input);
    const b = calculateBilling({ ...input, products: [...input.products].reverse(), work: [...input.work].reverse(), rateRules: [...input.rateRules].reverse() });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('totalsOf: 除外した報告の明細は小計に含めない', () => {
    const t = totalsOf([{ amountYen: 100, reportId: 'a' }, { amountYen: 50, reportId: 'b' }, { amountYen: 7, reportId: null }], '0.10', new Set(['a']));
    expect(t).toEqual({ subtotalYen: 57, taxYen: 6, totalYen: 63, taxRate: '0.10' });
  });

  it('canonicalJson: key 昇順・空白なし・undefined を除く', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
  });
});
