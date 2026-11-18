import { describe, expect, it } from 'vitest';
import {
  EXT,
  allocateFifo,
  audit,
  balanceOf,
  InventoryLotShortError,
  monthSheet,
  perHour,
  planDelivery,
  planInspection,
  planReplenish,
  planReversal,
  planStocktake,
  planReportInventory,
  planOpening,
  previewIssues,
  replay,
  adjustIsLow,
  defaultBoxes,
  type Movement,
  type PlannedMovement,
} from './inventory';
import golden from './__fixtures__/inventory-golden.json';
import realData from './__fixtures__/inventory-real.json';

interface GoldenCase {
  id: string;
  expected: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const gc = (id: string): GoldenCase => {
  const c = (golden.cases as GoldenCase[]).find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} not found`);
  return c;
};

/** 計画した取引に id・seq を付ける */
const seqify = (arr: readonly PlannedMovement[], start = 1): Movement[] => arr.map((m, i) => ({ ...m, id: `M${String(start + i).padStart(5, '0')}`, seq: start + i }));
const append = (cur: Movement[], planned: readonly PlannedMovement[]): Movement[] => [...cur, ...seqify(planned, cur.length + 1)];
const bal = (mv: Movement[], pid: string, d: string) => {
  const b = balanceOf(mv, pid, d);
  return { deposit: b.deposit, adjust: b.adjust, lots: b.lots.map((l) => ({ lotKey: l.lotKey, lotDate: l.lotDate, quantity: l.quantity })) };
};
const open = (pid: string, date: string, to: 'ADJ' | 'LOT', qty: number): PlannedMovement => ({ productId: pid, businessDate: date, type: 'OPENING', fromBucket: EXT.OPEN, toBucket: to, quantity: qty, meta: {}, ...(to === 'LOT' ? { lotKey: `${date}|open`, lotDate: date, lotLabel: 'open' } : {}) });
const insp = (pid: string, date: string, key: string, actual: number, ng: number, boxes: number, unit: number, adj: boolean) =>
  planInspection({ productId: pid, businessDate: date, lotKey: key, lotLabel: key, actual, defectTotal: ng, boxes, unitsPerBox: unit, adjustManaged: adj });

/** 実例（8月の手書きの表・9月の現場用 Excel）から取引を作る（試作 1.1 と同じ手順） */
function buildReal(pidMN: string, pidFPR: string): Movement[] {
  let out: Movement[] = [];
  const push = (arr: readonly PlannedMovement[]): void => {
    out = append(out, arr);
  };
  const key = (d: string, tag = ''): string => `${d}|実例${tag}`;
  const lab = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8))} 選別分（実例）`;
  push(planInspection({ productId: pidMN, businessDate: '2026-07-31', lotKey: key('2026-07-31'), lotLabel: lab('2026-07-31'), actual: 2000, defectTotal: 0, boxes: 8, unitsPerBox: 250, adjustManaged: false }));
  push([{ productId: pidMN, businessDate: '2026-07-31', type: 'OPENING', fromBucket: EXT.OPEN, toBucket: 'ADJ', quantity: 28, meta: {} }]);
  for (const a of realData.mn_aug) {
    const k = key(a.date);
    if (a.actual) {
      push(planInspection({ productId: pidMN, businessDate: a.date, lotKey: k, lotLabel: lab(a.date), actual: a.actual, defectTotal: a.ng, boxes: Math.round(a.actual / 250), unitsPerBox: 250, adjustManaged: true, meta: { ngBy: {}, lotNo: '' } }));
      if (a.rep) push(planReplenish({ productId: pidMN, businessDate: a.date, lotKey: k, lotDate: a.date, lotLabel: lab(a.date), quantity: a.rep * 250, reason: '1箱を補充用へ' }));
    }
    if (a.dlv) push(planDelivery({ productId: pidMN, businessDate: a.date, allocations: allocateFifo(out, pidMN, a.date, a.dlv) }));
  }
  const ngKeys = ['破れ', '加硫', 'その他', '融合不良'] as const;
  for (const r of realData.mn_sep as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r['sel']) {
      const ngBy: Record<string, number> = {};
      for (const k of ngKeys) if (r[`ng_${k}`]) ngBy[k] = r[`ng_${k}`] as number;
      const ng = Object.values(ngBy).reduce((a, b) => a + b, 0);
      push(planInspection({ productId: pidMN, businessDate: r['date'], lotKey: key(r['date']), lotLabel: lab(r['date']), actual: r['sel'], defectTotal: ng, boxes: Math.round(r['sel'] / 250), unitsPerBox: 250, adjustManaged: true, meta: { ngBy, lotNo: r['lot'] || '', writer: r['writer'] || '', hours: r['hours'] || 0 } }));
    }
    if (r['dlv']) push(planDelivery({ productId: pidMN, businessDate: r['date'], allocations: allocateFifo(out, pidMN, r['date'], r['dlv']) }));
  }
  for (const r of realData.fpr_sep as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r['sel']) push(planInspection({ productId: pidFPR, businessDate: r['date'], lotKey: key(r['date'], 'FPR'), lotLabel: lab(r['date']), actual: r['sel'], defectTotal: 0, boxes: Math.round(r['sel'] / 360), unitsPerBox: 360, adjustManaged: false, meta: { ngBy: {}, lotNo: r['lot'] || '', writer: r['writer'] || '', hours: r['hours'] || 0 } }));
    if (r['dlv']) push(planDelivery({ productId: pidFPR, businessDate: r['date'], allocations: allocateFifo(out, pidFPR, r['date'], r['dlv']) }));
  }
  return out;
}

describe('INV-04 箱の誤差', () => {
  it('248個: 調整用から2補充／251個: 余り1を調整用へ', () => {
    const e = gc('INV-04').expected;
    let mv = append([], [open('P', '2026-09-01', 'ADJ', 50)]);
    const p248 = insp('P', '2026-09-02', 'k248', 248, 0, 1, 250, true);
    mv = append(mv, p248);
    const a = bal(mv, 'P', '2026-09-02');
    expect(a.adjust).toBe(e['after248'].adjust);
    expect(a.lots[0]?.quantity).toBe(e['after248'].lotQuantity);
    expect(p248.map((x) => `${x.type}:${x.quantity}`)).toEqual(e['after248'].movementTypes);
    const p251 = insp('P', '2026-09-03', 'k251', 251, 0, 1, 250, true);
    mv = append(mv, p251);
    const b = bal(mv, 'P', '2026-09-03');
    expect(b.adjust).toBe(e['after251'].adjust);
    expect(b.deposit).toBe(e['after251'].lotQuantityTotal);
    expect(p251.map((x) => `${x.type}:${x.quantity}`)).toEqual(e['after251'].movementTypes);
  });
});

describe('INV-05 不良の補充', () => {
  it('良品1,245＋補充5＝ロット1,250。調整用30→25。不良は在庫の外', () => {
    const e = gc('INV-05').expected;
    const mv = append(append([], [open('P', '2026-09-01', 'ADJ', 30)]), insp('P', '2026-09-02', 'k', 1250, 5, 5, 250, true));
    expect(bal(mv, 'P', '2026-09-02').deposit).toBe(e['deposit']);
    expect(bal(mv, 'P', '2026-09-02').adjust).toBe(e['adjust']);
    expect(mv.slice(1).map((m) => ({ type: m.type, from: m.fromBucket, to: m.toBucket, quantity: m.quantity }))).toEqual(
      (e['movements'] as { type: string; from: string; to: string; quantity: number }[]).map((m) => ({ type: m.type, from: m.from, to: m.to, quantity: m.quantity })),
    );
  });
});

describe('INV-06 調整用在庫の不足', () => {
  it('−38 個になる問題点を返す（previewIssues で確定前に分かる）', () => {
    const e = gc('INV-06').expected;
    const base = append([], [open('P', '2026-09-01', 'ADJ', 262)]);
    const planned = insp('P', '2026-09-02', 'k', 1250, 300, 5, 250, true);
    const pv = previewIssues(base, planned);
    expect(pv.issues.map((i) => ({ kind: i.kind, quantity: i.quantity }))).toEqual([{ kind: e['issues'][0].kind, quantity: e['issues'][0].quantity }]);
    const r = replay(append(base, planned));
    expect(r.balances['P']?.adjust).toBe(e['adjustAfter']);
  });
});

describe('INV-07 同じ日・別ロットの訂正', () => {
  it('L2 だけ 750 に。L1 は 1,000 のまま', () => {
    const e = gc('INV-07').expected;
    const k1 = '2026-09-01|WR-A|1';
    const k2 = '2026-09-01|WR-B|1';
    let mv = append(append([], insp('P', '2026-09-01', k1, 1000, 0, 4, 250, false)), insp('P', '2026-09-01', k2, 500, 0, 2, 250, false));
    const orig = mv.filter((m) => m.lotKey === k2);
    mv = append(mv, orig.map((m) => planReversal(m, '訂正')));
    mv = append(mv, insp('P', '2026-09-01', k2, 750, 0, 3, 250, false));
    expect(bal(mv, 'P', '2026-09-01').lots).toEqual(e['lots']);
    expect(mv.length).toBe(e['movementCountAfter']);
  });
});

describe('INV-09 取消しと二重取消し', () => {
  it('振替→取消し→再振替。二重の取消しは監査で検出', () => {
    const e = gc('INV-09').expected;
    const k = '2026-09-01|WR-A|1';
    let mv = append([], insp('P', '2026-09-01', k, 1250, 0, 5, 250, false));
    const rep = (reason: string) => planReplenish({ productId: 'P', businessDate: '2026-09-02', lotKey: k, lotDate: '2026-09-01', lotLabel: k, quantity: 250, reason });
    mv = append(mv, rep('1箱回す'));
    const last = mv[mv.length - 1] as Movement;
    mv = append(mv, [planReversal(last, '取消し')]);
    expect(bal(mv, 'P', '2026-09-30')).toEqual(e['afterReverse']);
    mv = append(mv, rep('再振替'));
    expect(bal(mv, 'P', '2026-09-30')).toEqual(e['afterReplenishAgain']);
    expect(audit(mv).ok).toBe(true);
    const bad = append(mv, [planReversal(last, '二重の取消し')]);
    const a = audit(bad);
    expect(a.ok).toBe(e['doubleReversalAuditOk']);
    expect(a.errors).toEqual(e['doubleReversalAuditErrors']);
  });
});

describe('INV-R1 実例の再現（8月・9月）／INV-08 繰り返しの修正', () => {
  const real = buildReal('MN', 'FPR');
  const e = gc('INV-R1').expected;

  it('保存則が成立し問題点がない', () => {
    const a = audit(real);
    expect(a.ok).toBe(true);
    expect(a.issues).toHaveLength(0);
    expect(real.length).toBe((golden.cases.find((c) => c.id === 'INV-R1')?.input as { movementCount: number }).movementCount);
  });

  it('各日の残高が一致する', () => {
    for (const x of e['balances'] as { date: string; deposit: number; adjust: number; lots: unknown[] }[]) {
      expect(bal(real, 'MN', x.date), x.date).toEqual({ deposit: x.deposit, adjust: x.adjust, lots: x.lots });
    }
  });

  it('納入の引当（先入れ先出し）', () => {
    const got = real.filter((m) => m.type === 'DELIVERY' && m.productId === 'MN' && m.businessDate < '2026-08-25').map((m) => ({ deliveredOn: m.businessDate, fromLotDate: m.lotDate, quantity: m.quantity }));
    expect(got).toEqual(e['deliveryAllocation']);
  });

  it('在庫集計表の合計（2通りの数え方）と FPR', () => {
    for (const m of e['months'] as { month: string; countBy: 'INSPECTION_MONTH' | 'DELIVERY_MONTH'; rows: number; [k: string]: unknown }[]) {
      const s = monthSheet(real, 'MN', m.month, m.countBy);
      const { month, countBy, rows, openAdj, closeAdj, ...rest } = m as typeof m & { openAdj: number; closeAdj: number };
      void month; void countBy;
      expect(s.rows.length).toBe(rows);
      expect(s.totals).toEqual({ ...rest, openAdjust: openAdj, closeAdjust: closeAdj });
    }
    const { openAdj: fo, closeAdj: fc, ...frest } = e['fpr'] as Record<string, unknown>;
    expect(monthSheet(real, 'FPR', '2026-09', 'INSPECTION_MONTH').totals).toEqual({ ...frest, openAdjust: fo, closeAdjust: fc });
  });

  it('9月の記載のある当日残 19 行・8月 16 行がすべて一致する', () => {
    let n = 0;
    for (const r of realData.mn_sep as { date: string; end: number | null }[]) {
      if (r.end == null) continue;
      expect(balanceOf(real, 'MN', r.date).adjust, r.date).toBe(r.end);
      n++;
    }
    for (const r of realData.mn_aug as { date: string; endAdj: number | null }[]) {
      if (r.endAdj == null) continue;
      expect(balanceOf(real, 'MN', r.date).adjust, r.date).toBe(r.endAdj);
      n++;
    }
    expect(n).toBe(35);
  });

  it('INV-08: 同じ内容で何度修正しても増えない／不良を2増やすと調整用が2減る', () => {
    const exp = gc('INV-08').expected['septemberEnd'];
    expect(bal(real, 'MN', '2026-09-30')).toMatchObject(exp.before);
    const orig = real.filter((m) => m.productId === 'MN' && m.businessDate === '2026-09-03' && ['INSPECT', 'NG', 'FILL', 'SURPLUS'].includes(m.type));
    const ins = orig.find((m) => m.type === 'INSPECT') as Movement;
    const meta0 = ins.meta;
    const revise = (cur: Movement[], plus: number): Movement[] => {
      const live = cur.filter((m) => m.productId === 'MN' && m.businessDate === '2026-09-03' && ['INSPECT', 'NG', 'FILL', 'SURPLUS'].includes(m.type) && !cur.some((x) => x.reversalOf === m.id));
      const withRev = append(cur, live.map((m) => planReversal(m, '訂正')));
      return append(withRev, planInspection({ productId: 'MN', businessDate: '2026-09-03', lotKey: ins.lotKey as string, lotLabel: ins.lotLabel as string, actual: meta0.actual as number, defectTotal: (meta0.defectTotal as number) + plus, boxes: meta0.boxes as number, unitsPerBox: 250, adjustManaged: true, meta: { ...meta0, defectTotal: (meta0.defectTotal as number) + plus } }));
    };
    let cur = revise(real, 2);
    expect(bal(cur, 'MN', '2026-09-30')).toMatchObject(exp.afterDefectsPlus2);
    cur = revise(cur, 2);
    cur = revise(cur, 2);
    expect(bal(cur, 'MN', '2026-09-30')).toMatchObject(exp.afterDefectsPlus2);
    expect(audit(cur).ok).toBe(true);
  });
});

describe('納入・棚卸・開始残高・目安', () => {
  it('預かりが足りない納入は InventoryLotShortError', () => {
    const mv = append([], insp('P', '2026-09-01', 'k', 500, 0, 2, 250, false));
    expect(() => allocateFifo(mv, 'P', '2026-09-02', 600)).toThrow(InventoryLotShortError);
  });
  it('納入は古いロットから、複数ロットは1ロット1件', () => {
    let mv = append([], insp('P', '2026-09-01', 'a', 500, 0, 2, 250, false));
    mv = append(mv, insp('P', '2026-09-02', 'b', 500, 0, 2, 250, false));
    const alloc = allocateFifo(mv, 'P', '2026-09-03', 700);
    expect(alloc.map((x) => [x.lotKey, x.quantity])).toEqual([['a', 500], ['b', 200]]);
    expect(planDelivery({ productId: 'P', businessDate: '2026-09-03', allocations: alloc })).toHaveLength(2);
  });
  it('開始残高→棚卸（理由必須）', () => {
    let mv = append([], planOpening({ productId: 'P', businessDate: '2026-09-01', adjust: 100, lots: [{ lotKey: '2026-08-31|開始', lotDate: '2026-08-31', lotLabel: '開始', quantity: 1000 }] }));
    expect(bal(mv, 'P', '2026-09-01')).toMatchObject({ deposit: 1000, adjust: 100 });
    expect(() => planStocktake(mv, { productId: 'P', businessDate: '2026-09-02', countDeposit: 990, countAdjust: 100, adjustManaged: true, reason: ' ' })).toThrow();
    mv = append(mv, planStocktake(mv, { productId: 'P', businessDate: '2026-09-02', countDeposit: 990, countAdjust: 105, adjustManaged: true, reason: '数え直し' }));
    expect(bal(mv, 'P', '2026-09-02')).toMatchObject({ deposit: 990, adjust: 105 });
    expect(audit(mv).ok).toBe(true);
  });
  it('目安・箱数の初期値・1時間あたり個数（0 は空欄）', () => {
    const cfg = { inventoryManaged: true, unitsPerBox: 250, adjustStockManaged: true, adjustLowThreshold: 20 };
    expect(adjustIsLow({ adjust: 14, deposit: 0, lots: [] }, cfg)).toBe(true);
    expect(adjustIsLow({ adjust: 20, deposit: 0, lots: [] }, cfg)).toBe(false);
    expect(adjustIsLow({ adjust: 0, deposit: 0, lots: [] }, { ...cfg, adjustStockManaged: false })).toBe(false);
    expect(defaultBoxes(1250, 250)).toBe(5);
    expect(perHour(1250, 0)).toBeNull();
    expect(perHour(1250, null)).toBeNull();
    expect(perHour(1250, 5)).toBe(250);
  });
});

describe('日報の確定に伴う取引（planReportInventory）', () => {
  const base = { productId: 'P', reportId: 'WR-1', businessDate: '2026-09-02', lotKey: '2026-09-02|DR-1|1', lotLabel: '9/2 選別分', unitsPerBox: 250, adjustManaged: true } as const;

  it('検品＋1箱回す＋納入が1回の確定で作られ、納入は作業日と別の日にできる', () => {
    let mv = append([], [open('P', '2026-09-01', 'ADJ', 14), { ...open('P', '2026-09-01', 'LOT', 1000), lotKey: '2026-08-31|d', lotDate: '2026-08-31', lotLabel: 'd' }]);
    mv = append(mv, planReportInventory(mv, { ...base, revisionNo: 1, actual: 1250, defectTotal: 12, boxes: 5, replenishBoxes: 1, deliveredQuantity: 1000, deliveredDate: '2026-09-03' }));
    const b = bal(mv, 'P', '2026-09-03');
    expect(b.adjust).toBe(14 + 250 - 12);
    expect(b.deposit).toBe(1000 + 1250 - 250 - 1000);
    expect(mv.filter((m) => m.type === 'DELIVERY').map((m) => [m.businessDate, m.lotDate, m.quantity])).toEqual([['2026-09-03', '2026-08-31', 1000]]);
    expect(audit(mv).ok).toBe(true);
  });

  it('日報の修正（再確定）は前の版の取引を取り消して作り直す。何度でも残高は増えない', () => {
    let mv: Movement[] = append([], [open('P', '2026-09-01', 'ADJ', 50)]);
    mv = append(mv, planReportInventory(mv, { ...base, revisionNo: 1, actual: 1250, defectTotal: 5, boxes: 5 }));
    const once = bal(mv, 'P', '2026-09-30');
    for (let r = 2; r <= 4; r++) mv = append(mv, planReportInventory(mv, { ...base, revisionNo: r, actual: 1250, defectTotal: 5, boxes: 5 }));
    expect(bal(mv, 'P', '2026-09-30')).toEqual(once);
    mv = append(mv, planReportInventory(mv, { ...base, revisionNo: 5, actual: 1250, defectTotal: 7, boxes: 5 }));
    expect(bal(mv, 'P', '2026-09-30')).toMatchObject({ deposit: 1250, adjust: 43 });
    expect(audit(mv).ok).toBe(true);
  });

  it('納入数があるのに納入日が無い／在庫が足りない納入は例外', () => {
    const mv = append([], [open('P', '2026-09-01', 'ADJ', 50)]);
    expect(() => planReportInventory(mv, { ...base, revisionNo: 1, actual: 1250, defectTotal: 0, boxes: 5, deliveredQuantity: 100 })).toThrow('納入日');
    expect(() => planReportInventory(mv, { ...base, revisionNo: 1, actual: 1250, defectTotal: 0, boxes: 5, deliveredQuantity: 1300, deliveredDate: '2026-09-02' })).toThrow(InventoryLotShortError);
  });

  it('調整用在庫を管理しない品番で「1箱回す」は例外', () => {
    expect(() => planReportInventory([], { ...base, adjustManaged: false, revisionNo: 1, actual: 1000, defectTotal: 0, boxes: 4, replenishBoxes: 1 })).toThrow('調整用在庫を管理していません');
  });
});
