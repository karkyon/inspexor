import { describe, it, expect } from 'vitest';
import { interpretLoginResponse } from './login-response';

describe('interpretLoginResponse', () => {
  it('200 + 正しいdataはsuccessを返す', () => {
    const body = { data: { userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'], csrfToken: 'tok' } };
    const outcome = interpretLoginResponse(200, body);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.data.displayName).toBe('田中太郎');
    }
  });

  it('401 AUTH_REQUIREDは専用メッセージ', () => {
    const outcome = interpretLoginResponse(401, { error: { code: 'AUTH_REQUIRED' } });
    expect(outcome).toEqual({ kind: 'error', message: 'ログインIDまたはパスワードが正しくありません。' });
  });

  it('423 ACCOUNT_LOCKEDは専用メッセージ', () => {
    const outcome = interpretLoginResponse(423, { error: { code: 'ACCOUNT_LOCKED' } });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('ロック');
    }
  });

  it('422 VALIDATION_ERRORは専用メッセージ', () => {
    const outcome = interpretLoginResponse(422, { error: { code: 'VALIDATION_ERROR' } });
    expect(outcome.kind).toBe('error');
  });

  it('未知のエラーコードはステータス付き汎用メッセージ', () => {
    const outcome = interpretLoginResponse(500, { error: { code: 'INTERNAL_ERROR' } });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('500');
    }
  });

  it('bodyが壊れている場合は汎用メッセージ（例外を投げない）', () => {
    expect(() => interpretLoginResponse(500, null)).not.toThrow();
    expect(() => interpretLoginResponse(200, 'not-json-shape')).not.toThrow();
    const outcome = interpretLoginResponse(200, {});
    expect(outcome.kind).toBe('error');
  });

  it('200だがdata形状が不正ならerror扱い', () => {
    const outcome = interpretLoginResponse(200, { data: { userId: 123 } });
    expect(outcome.kind).toBe('error');
  });

  it('CHG-012: 確認待ち（mfaRequired）は mfa を返す', () => {
    const outcome = interpretLoginResponse(200, { data: { mfaRequired: true, mfaEnrolled: false, challenge: 'c'.repeat(30), challengeExpiresAt: '2026-10-15T00:05:00Z' } });
    expect(outcome).toMatchObject({ kind: 'mfa', data: { mfaEnrolled: false } });
  });

  it('CHG-012: 429 RATE_LIMITED は時間をおく案内', () => {
    expect(interpretLoginResponse(429, { error: { code: 'RATE_LIMITED' } })).toEqual({ kind: 'error', message: 'しばらく時間をおいてから再度お試しください。' });
  });
});
