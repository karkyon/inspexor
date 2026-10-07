import { describe, it, expect } from 'vitest';
import { issueCsrfToken, verifyCsrfToken } from './csrf';

const SECRET = 'x'.repeat(32);

describe('csrf: SEC-005準拠（HMAC double-submit）', () => {
  it('発行したtokenは同一sessionId/secretで検証OK', () => {
    const token = issueCsrfToken('session-1', SECRET);
    expect(verifyCsrfToken(token, 'session-1', SECRET)).toBe(true);
  });

  it('別sessionIdでは検証NG', () => {
    const token = issueCsrfToken('session-1', SECRET);
    expect(verifyCsrfToken(token, 'session-2', SECRET)).toBe(false);
  });

  it('別secretでは検証NG', () => {
    const token = issueCsrfToken('session-1', SECRET);
    expect(verifyCsrfToken(token, 'session-1', 'y'.repeat(32))).toBe(false);
  });

  it('改ざんされたtokenは検証NG', () => {
    const token = issueCsrfToken('session-1', SECRET);
    const tampered = `${token}x`;
    expect(verifyCsrfToken(tampered, 'session-1', SECRET)).toBe(false);
  });

  it('形式不正なtokenは検証NG（例外を投げない）', () => {
    expect(verifyCsrfToken('not-a-valid-token', 'session-1', SECRET)).toBe(false);
    expect(verifyCsrfToken('', 'session-1', SECRET)).toBe(false);
    expect(verifyCsrfToken('a.b.c', 'session-1', SECRET)).toBe(false);
  });

  it('毎回異なるtokenを発行する（nonceのランダム性）', () => {
    const t1 = issueCsrfToken('session-1', SECRET);
    const t2 = issueCsrfToken('session-1', SECRET);
    expect(t1).not.toBe(t2);
  });
});
