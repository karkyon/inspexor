import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, totpStep, verifyTotp } from './totp';
import { decryptMfaSecret, encryptMfaSecret, generateRecoveryCodes, hashRecoveryCode, issueMfaChallenge, verifyMfaChallenge } from './mfa-crypto';

// RFC 4226 付録 D / RFC 6238 付録 B の試験値
const KEY = Buffer.from('12345678901234567890');

describe('CHG-012 TOTP（RFC 6238）', () => {
  it('HOTP の試験値（RFC 4226）', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(KEY, c))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  });
  it('TOTP の試験値（RFC 6238、SHA1・8桁の下6桁）', () => {
    expect(totp(KEY, 59_000)).toBe('287082');
    expect(totp(KEY, 1111111109_000)).toBe('081804');
    expect(totp(KEY, 1234567890_000)).toBe('005924');
  });
  it('Base32 の往復', () => {
    expect(base32Encode(KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(KEY)).toBe(true);
  });
  it('照合: 前後1区間まで可、使用済みの区間（lastStep 以前）は不可', () => {
    const now = 1_760_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(KEY, totp(KEY, now), now, 0)).toBe(step);
    expect(verifyTotp(KEY, totp(KEY, now - 30_000), now, 0)).toBe(step - 1);
    expect(verifyTotp(KEY, totp(KEY, now + 30_000), now, 0)).toBe(step + 1);
    expect(verifyTotp(KEY, totp(KEY, now - 60_000), now, 0)).toBeNull();
    expect(verifyTotp(KEY, totp(KEY, now), now, step)).toBeNull();
  });
  it('otpauth URI', () => {
    expect(otpauthUri('ABC', 'admin')).toBe('otpauth://totp/INSPEXOR%3Aadmin?secret=ABC&issuer=INSPEXOR&algorithm=SHA1&digits=6&period=30');
  });
});

describe('CHG-012 多要素認証の暗号', () => {
  const S = 'k'.repeat(40);
  it('秘密鍵は AES-GCM（別の鍵・改ざんは復号できない）', () => {
    const enc = encryptMfaSecret(KEY, S);
    expect(enc).not.toContain(base32Encode(KEY));
    expect(decryptMfaSecret(enc, S).equals(KEY)).toBe(true);
    expect(() => decryptMfaSecret(enc, 'z'.repeat(40))).toThrow();
    expect(() => decryptMfaSecret(`${enc.slice(0, -3)}AAA`, S)).toThrow();
  });
  it('回復コード: 10個・重複なし・XXXX-XXXX、保存値は利用者ごとに違う', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(hashRecoveryCode('u1', codes[0] as string, S)).not.toBe(hashRecoveryCode('u2', codes[0] as string, S));
  });
  it('確認待ち: 署名・期限', () => {
    const t = issueMfaChallenge({ v: 1, uid: 'u', exp: 2_000, acs: 0 }, S);
    expect(verifyMfaChallenge(t, S, 1_000)).toMatchObject({ uid: 'u' });
    expect(verifyMfaChallenge(t, S, 2_001)).toBeNull();
    expect(verifyMfaChallenge(t, 'z'.repeat(40), 1_000)).toBeNull();
    expect(verifyMfaChallenge(`${t}x`, S, 1_000)).toBeNull();
  });
});
