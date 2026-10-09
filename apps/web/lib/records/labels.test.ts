import { describe, it, expect } from 'vitest';
import { currentMonthRangeJst, documentStatusLabel, statusLabel, yenLabel, REVISABLE } from './labels';

describe('報告ラベル', () => {
  it('状態・帳票・金額', () => {
    expect(statusLabel('SUBMITTED')).toBe('提出済');
    expect(statusLabel('X')).toBe('X');
    expect(documentStatusLabel('DRAFT', null)).toBe('—');
    expect(documentStatusLabel('CONFIRMED', null)).toBe('作成中');
    expect(documentStatusLabel('SUBMITTED', 'GENERATED')).toBe('作成済');
    expect(documentStatusLabel('CONFIRMED', 'FAILED_FINAL')).toBe('エラー');
    expect(yenLabel(null)).toBe('未確定');
    expect(yenLabel(2500)).toBe('2,500円');
    expect(REVISABLE).not.toContain('DRAFT');
  });
  it('JST の今月（UTC 15:00 以降は翌日扱い）', () => {
    expect(currentMonthRangeJst(new Date('2026-10-31T15:30:00Z'))).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(currentMonthRangeJst(new Date('2026-10-08T03:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-08' });
  });
});
