import { describe, it, expect } from 'vitest';
import { decideRate, isRecentAuth, mfaRequiredFor, normalizeRecoveryCode, normalizeTotpCode, RATE_LIMITS, rateWindowStart } from './security-policy';

describe('CHG-012 回数制限（SEC-009）', () => {
  it('固定区間: 上限までは可、超えたら区間の終わりまでの秒数を返す', () => {
    const rule = { limit: 3, windowMs: 60_000 };
    const now = 120_000 + 15_000;
    expect(rateWindowStart(now, 60_000)).toBe(120_000);
    expect(decideRate(3, rule, now)).toEqual({ ok: true, remaining: 0 });
    expect(decideRate(4, rule, now)).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(decideRate(4, rule, 179_999)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });
  it('既定値: ログインは接続元 100回/10分・ログインID 30回/10分、更新 120回/分、参照 600回/分', () => {
    expect(RATE_LIMITS.loginIp).toEqual({ limit: 100, windowMs: 600_000 });
    expect(RATE_LIMITS.loginId).toEqual({ limit: 30, windowMs: 600_000 });
    expect(RATE_LIMITS.command.limit).toBe(120);
    expect(RATE_LIMITS.read.limit).toBe(600);
  });
});

describe('CHG-012 多要素認証・再認証（SEC-004 / SEC-026）', () => {
  it('確認コードは数字6桁（空白・ハイフンは無視）', () => {
    expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
    expect(normalizeTotpCode('123-456')).toBe('123456');
    expect(normalizeTotpCode('12345')).toBeNull();
    expect(normalizeTotpCode('12345a')).toBeNull();
  });
  it('回復コードは XXXX-XXXX（大文字に揃える。0/O/1/I は使わない）', () => {
    expect(normalizeRecoveryCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(normalizeRecoveryCode('ABCD-EFG2')).toBe('ABCD-EFG2');
    expect(normalizeRecoveryCode('ABCD-EFG0')).toBeNull();
    expect(normalizeRecoveryCode('ABC-DEF')).toBeNull();
  });
  it('多要素認証は機能が有効で管理者ロールを持つ利用者だけ', () => {
    expect(mfaRequiredFor(['ADMIN'], true)).toBe(true);
    expect(mfaRequiredFor(['OFFICE', 'ADMIN'], true)).toBe(true);
    expect(mfaRequiredFor(['OFFICE'], true)).toBe(false);
    expect(mfaRequiredFor(['ADMIN'], false)).toBe(false);
  });
  it('再認証は直近10分以内の認証', () => {
    const now = new Date('2026-10-15T00:10:00Z');
    expect(isRecentAuth(new Date('2026-10-15T00:00:00Z'), now)).toBe(true);
    expect(isRecentAuth(new Date('2026-10-14T23:59:59Z'), now)).toBe(false);
  });
});
