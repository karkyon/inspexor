import { describe, it, expect } from 'vitest';
import {
  computeBusinessTime,
  formatReportNo,
  jstToInstant,
  mergeDeliveryItems,
  nextReportNo,
  reportMonthOf,
  toJstParts,
  validateDeliveryItems,
  validateWorkQuantities,
  validateWorkSpan,
} from './index';

const at = (iso: string) => new Date(iso);

describe('JST 変換', () => {
  it('UTC → JST の日付・時刻', () => {
    expect(toJstParts(at('2026-10-07T15:30:00Z'))).toMatchObject({ date: '2026-10-08', time: '00:30' });
  });
  it('JST 日付+時刻 → UTC、24:00 は翌日0:00', () => {
    expect(jstToInstant('2026-10-08', '09:00')).toBe('2026-10-08T00:00:00.000Z');
    expect(jstToInstant('2026-10-08', '24:00')).toBe('2026-10-08T15:00:00.000Z');
    expect(() => jstToInstant('2026-10-08', '24:05')).toThrow();
  });
});

describe('validateWorkSpan（同一業務日・5分刻み・日跨ぎ不可）', () => {
  it('正常: 13:00–18:00', () => {
    expect(validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-08', '13:00')), at(jstToInstant('2026-10-08', '18:00')))).toEqual({ ok: true, start: '13:00', end: '18:00' });
  });
  it('終了 翌日0:00 は 24:00 として可', () => {
    expect(validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-08', '20:00')), at(jstToInstant('2026-10-08', '24:00')))).toEqual({ ok: true, start: '20:00', end: '24:00' });
  });
  it('開始が作業日と別日・5分刻みでない・日跨ぎ・順序逆を拒否', () => {
    const r1 = validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-07', '23:00')), at(jstToInstant('2026-10-08', '01:00')));
    expect(r1.ok).toBe(false);
    const r2 = validateWorkSpan('2026-10-08', at('2026-10-08T00:03:00Z'), at('2026-10-08T01:00:00Z'));
    expect(r2.ok === false && r2.issues.map((i) => i.code)).toEqual(['step']);
    const r3 = validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-08', '22:00')), at(jstToInstant('2026-10-09', '01:00')));
    expect(r3.ok === false && r3.issues.map((i) => i.code)).toEqual(['cross_day']);
    const r4 = validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-08', '10:00')), at(jstToInstant('2026-10-08', '10:00')));
    expect(r4.ok === false && r4.issues.map((i) => i.code)).toEqual(['order']);
    const r5 = validateWorkSpan('2026-10-08', at('2026-10-08T00:00:30Z'), at('2026-10-08T01:00:00Z'));
    expect(r5.ok === false && r5.issues.map((i) => i.code)).toEqual(['step']);
  });
  it('検証結果を computeBusinessTime にそのまま渡せる（17時跨ぎ・2名）', () => {
    const r = validateWorkSpan('2026-10-08', at(jstToInstant('2026-10-08', '13:00')), at(jstToInstant('2026-10-08', '18:00')));
    if (!r.ok) throw new Error('unexpected');
    expect(computeBusinessTime({ date: '2026-10-08', start: r.start, end: r.end, workers: 2 })).toEqual({
      breakMinutes: 0, regularMinutes: 240, overtimeMinutes: 60, regularPersonMinutes: 480, overtimePersonMinutes: 120,
    });
  });
});

describe('報告番号（WR|DR-YYYYMM-6桁、作成日JSTの月）', () => {
  it('作成日 JST の月', () => {
    expect(reportMonthOf(at('2026-09-30T15:00:00Z'))).toBe('202610');
    expect(reportMonthOf(at('2026-09-30T14:59:59Z'))).toBe('202609');
  });
  it('初番・連番・形式', () => {
    expect(nextReportNo('WR', at('2026-10-08T00:00:00Z'), null)).toBe('WR-202610-000001');
    expect(nextReportNo('DR', at('2026-10-08T00:00:00Z'), 'DR-202610-000046')).toBe('DR-202610-000047');
    expect(() => nextReportNo('WR', at('2026-10-08T00:00:00Z'), 'WR-202609-000001')).toThrow();
    expect(() => formatReportNo('WR', '202610', 1_000_000)).toThrow();
  });
});

describe('運搬明細', () => {
  it('重複品番は数量を合算して1行に統合（出現順維持）', () => {
    expect(mergeDeliveryItems([{ productId: 'b', quantity: 2 }, { productId: 'a', quantity: 1 }, { productId: 'b', quantity: 3 }])).toEqual([
      { productId: 'b', quantity: 5 },
      { productId: 'a', quantity: 1 },
    ]);
  });
  it('数量範囲・重複を検出', () => {
    expect(validateDeliveryItems([{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 999_999 }])).toEqual([]);
    expect(validateDeliveryItems([{ productId: 'a', quantity: 1_000_000 }, { productId: 'a', quantity: 1 }]).map((i) => i.path)).toEqual([
      '/items/0/quantity',
      '/items/1/productId',
    ]);
  });
});

describe('作業の数量・作業者・不良', () => {
  it('境界: 数量 999999・作業者 50名・不良合計=数量 は可', () => {
    expect(validateWorkQuantities({ quantity: 999_999, workerIds: Array.from({ length: 50 }, (_, i) => `w${i}`), defects: [{ defectTypeId: 'd', quantity: 999_999 }] })).toEqual([]);
  });
  it('超過・重複を拒否', () => {
    const issues = validateWorkQuantities({
      quantity: 1_000_000,
      workerIds: Array.from({ length: 51 }, (_, i) => `w${i}`),
      defects: [{ defectTypeId: 'd', quantity: 1 }, { defectTypeId: 'd', quantity: 1 }],
    });
    expect(issues.map((i) => i.code)).toEqual(['range', 'range', 'duplicate']);
    expect(validateWorkQuantities({ quantity: 5, workerIds: ['w'], defects: [{ defectTypeId: 'a', quantity: 3 }, { defectTypeId: 'b', quantity: 3 }] }).map((i) => i.code)).toEqual(['exceeds_quantity']);
  });
});
