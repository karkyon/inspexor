import { describe, it, expect } from 'vitest';
import { isMonth, minutesToHours, monthRange, summarizeMonth, toCsv, type SummaryRow } from './monthly-summary';

const w = (date: string, productId: string, workTypeId: string, quantity: number, defect: number, actual: number, person: number, no: string): SummaryRow => ({
  type: 'WORK', reportId: no, reportNo: no, revisionNo: 1, date, customerId: 'c1', productId, workTypeId, quantity, defectQuantity: defect, actualMinutes: actual, personMinutes: person,
});
const d = (date: string, items: Array<[string, number]>, trips: number, fee: number | null, no: string): SummaryRow => ({
  type: 'DELIVERY', reportId: no, reportNo: no, revisionNo: 1, date, customerId: 'c1', items: items.map(([productId, quantity]) => ({ productId, quantity })), tripCount: trips, deliveryFeeYen: fee,
});

describe('月次集計（提案書 P.10 / CHG-004 D4）', () => {
  it('暦月の範囲（うるう年・月末）', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(() => monthRange('x')).toThrow();
  });

  it('合計・日別・品番別・作業内容別。運搬費は入力分だけ合計し未入力件数を数える。範囲外の日付は除外', () => {
    const rows = [
      w('2026-08-01', 'pA', 't1', 448, 5, 210, 210, 'WR-1'),
      w('2026-08-01', 'pA', 't2', 100, 0, 60, 120, 'WR-2'),
      w('2026-08-02', 'pB', 't1', 896, 3, 420, 840, 'WR-3'),
      d('2026-08-01', [['pA', 1200], ['pB', 400]], 1, 2500, 'DR-1'),
      d('2026-08-02', [['pA', 300]], 2, null, 'DR-2'),
      w('2026-09-01', 'pA', 't1', 9999, 0, 60, 60, 'WR-X'),
    ];
    const s = summarizeMonth('2026-08', rows);
    expect(s.totals).toEqual({
      workCount: 3, workQuantity: 1444, defectQuantity: 8, actualMinutes: 690, personMinutes: 1170,
      deliveryCount: 2, deliveryQuantity: 1900, tripCount: 3, deliveryFeeYen: 2500, deliveryFeeUnsetCount: 1,
    });
    expect(s.daily.map((x) => [x.date, x.workQuantity, x.deliveryQuantity, x.tripCount])).toEqual([
      ['2026-08-01', 548, 1600, 1],
      ['2026-08-02', 896, 300, 2],
    ]);
    expect(s.byProduct.find((p) => p.productId === 'pA')).toEqual({ productId: 'pA', workQuantity: 548, defectQuantity: 5, actualMinutes: 270, personMinutes: 330, deliveryQuantity: 1500 });
    expect(s.byWorkType.map((x) => `${x.productId}/${x.workTypeId}:${x.workCount}`)).toEqual(['pA/t1:1', 'pA/t2:1', 'pB/t1:1']);
    expect(s.rows.map((r) => r.reportNo)).toEqual(['DR-1', 'WR-1', 'WR-2', 'DR-2', 'WR-3']);
  });

  it('品番指定時は運搬数量をその品番の明細だけで数える（回数・運搬費は報告単位）', () => {
    const s = summarizeMonth('2026-08', [d('2026-08-01', [['pA', 1200], ['pB', 400]], 1, 2500, 'DR-1')], 'pB');
    expect(s.totals).toMatchObject({ deliveryQuantity: 400, tripCount: 1, deliveryFeeYen: 2500 });
    expect(s.byProduct.map((p) => p.productId)).toEqual(['pB']);
  });

  it('空の月は 0', () => {
    const s = summarizeMonth('2026-08', []);
    expect(s.totals.workQuantity).toBe(0);
    expect(s.daily).toEqual([]);
  });

  it('時間表示（分→時間、小数2桁）', () => {
    expect(minutesToHours(0)).toBe('0.00');
    expect(minutesToHours(115)).toBe('1.92');
    expect(minutesToHours(230)).toBe('3.83');
    expect(minutesToHours(59)).toBe('0.98');
    expect(minutesToHours(6705)).toBe('111.75');
  });

  it('CSV: BOM・CRLF・引用・数式インジェクション対策', () => {
    const csv = toCsv(['品名', '数量'], [['A,"B"', 1], ['=SUM(A1)', -2], [null, 0]]);
    expect(csv.startsWith('﻿品名,数量\r\n')).toBe(true);
    expect(csv).toContain('"A,""B""",1\r\n');
    expect(csv).toContain("'=SUM(A1),-2\r\n");
    expect(csv.endsWith(',0\r\n')).toBe(true);
  });
});
