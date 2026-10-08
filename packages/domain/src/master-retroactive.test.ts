import { describe, it, expect } from 'vitest';
import { jstBusinessDate, isRetroactiveChange, unionRange } from './master-retroactive';

describe('CHG-001 D7 遡及判定', () => {
  it('JST業務日: UTC 15:00 は翌日', () => {
    expect(jstBusinessDate(new Date('2026-10-08T14:59:59Z'))).toBe('2026-10-08');
    expect(jstBusinessDate(new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-09');
  });

  const today = '2026-10-08';
  it('RULE: 開始日が今日より前なら遡及', () => {
    expect(isRetroactiveChange('RULE', null, { from: '2026-10-07', to: null }, today)).toBe(true);
    expect(isRetroactiveChange('RULE', null, { from: '2026-10-08', to: null }, today)).toBe(false);
  });

  it('RULE: 変更前が過去に掛かっていれば、変更後が未来でも遡及', () => {
    expect(isRetroactiveChange('RULE', { from: '2026-01-01', to: null }, { from: '2026-11-01', to: null }, today)).toBe(true);
  });

  it('HOLIDAY: 過去日付の追加・変更は遡及', () => {
    expect(isRetroactiveChange('HOLIDAY', null, { from: '2026-05-05', to: '2026-05-05' }, today)).toBe(true);
    expect(isRetroactiveChange('HOLIDAY', null, { from: '2026-11-03', to: '2026-11-03' }, today)).toBe(false);
  });

  it('NONE（顧客・品番など）は遡及扱いしない', () => {
    expect(isRetroactiveChange('NONE', { from: '2000-01-01', to: null }, null, today)).toBe(false);
  });

  it('unionRange: 最小開始〜最大終了、どちらか無期限なら無期限', () => {
    expect(unionRange({ from: '2026-03-01', to: '2026-06-30' }, { from: '2026-01-01', to: '2026-04-30' })).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(unionRange({ from: '2026-03-01', to: null }, { from: '2026-01-01', to: '2026-04-30' })).toEqual({ from: '2026-01-01', to: null });
    expect(unionRange(null, null)).toBeNull();
  });
});
