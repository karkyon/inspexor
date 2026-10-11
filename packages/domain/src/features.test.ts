import { describe, expect, it } from 'vitest';
import { featureFlags } from './features';

describe('featureFlags（提案書の対象外機能は既定で無効）', () => {
  it('未設定はすべて無効', () => {
    expect(featureFlags({})).toEqual({ approval: false, billing: false, dailyMail: false });
  });
  it("文字列 'true' のときだけ有効（'1' や 'TRUE' は無効）", () => {
    expect(featureFlags({ APPROVAL_ENABLED: 'true', DAILY_MAIL_ENABLED: '1' })).toEqual({ approval: true, billing: false, dailyMail: false });
    expect(featureFlags({ APPROVAL_ENABLED: 'TRUE' }).approval).toBe(false);
  });
  it('請求は承認が有効なときだけ有効（請求の対象は承認済みの実績）', () => {
    expect(featureFlags({ BILLING_ENABLED: 'true' }).billing).toBe(false);
    expect(featureFlags({ APPROVAL_ENABLED: 'true', BILLING_ENABLED: 'true' }).billing).toBe(true);
  });
});
