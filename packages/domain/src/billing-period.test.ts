import { describe, it, expect } from 'vitest';
import { addDays, billingPeriodFor, closingDateForMonth, closingDateOf, inRange, rangesOverlap } from './billing-period';

describe('billing-period: 締め日と対象期間（前締め翌日〜当締め日）', () => {
  it('31日締めは月末', () => {
    expect(closingDateOf(2026, 2, 31)).toBe('2026-02-28');
    expect(closingDateOf(2028, 2, 31)).toBe('2028-02-29');
    expect(billingPeriodFor(31, '2026-08-31')).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(billingPeriodFor(31, '2026-03-31')).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });

  it('20日締めは前月21日から。年をまたぐ', () => {
    expect(billingPeriodFor(20, '2026-09-20')).toEqual({ start: '2026-08-21', end: '2026-09-20' });
    expect(billingPeriodFor(20, '2026-01-20')).toEqual({ start: '2025-12-21', end: '2026-01-20' });
  });

  it('30日締め: 2月は月末締め、3月は 3/1 から', () => {
    expect(billingPeriodFor(30, '2026-02-28')).toEqual({ start: '2026-01-31', end: '2026-02-28' });
    expect(billingPeriodFor(30, '2026-03-30')).toEqual({ start: '2026-03-01', end: '2026-03-30' });
  });

  it('締め日でない日付・不正な日付は null', () => {
    expect(billingPeriodFor(20, '2026-09-30')).toBeNull();
    expect(billingPeriodFor(31, '2026-02-30')).toBeNull();
    expect(billingPeriodFor(31, '2026/08/31')).toBeNull();
  });

  it('closingDateForMonth / addDays / inRange / rangesOverlap', () => {
    expect(closingDateForMonth('2026-09', 31)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(inRange('2026-09-01', '2026-09-01', null)).toBe(true);
    expect(inRange('2026-09-01', '2026-08-01', '2026-08-31')).toBe(false);
    expect(rangesOverlap({ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-30', to: null })).toBe(true);
    expect(rangesOverlap({ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-10-01', to: null })).toBe(false);
    expect(rangesOverlap({ from: '2026-09-01', to: null }, { from: '2020-01-01', to: '2026-08-31' })).toBe(false);
  });
});
