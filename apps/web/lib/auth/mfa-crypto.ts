/**
 * CHG-012 多要素認証の暗号まわり（鍵はすべて AUTH_SECRET から用途別に導出する）。
 *   - TOTP 秘密鍵の保存: AES-256-GCM（Firestore には暗号文だけ）
 *   - 回復コード: HMAC-SHA256 で保存（元の値は登録時に一度だけ表示）
 *   - 確認待ち（challenge）: パスワード確認の後の短期間（5分）だけ有効な署名付きの値。session ではない
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { MFA_RECOVERY_CODE_COUNT, RECOVERY_CODE_ALPHABET } from '@inspexor/domain';

function key(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`${secret}|${purpose}`).digest();
}

export function encryptMfaSecret(plain: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, 'mfa-secret-v1'), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptMfaSecret(text: string, secret: string): Buffer {
  const [v, iv, enc, tag] = text.split('.');
  if (v !== 'v1' || iv === undefined || enc === undefined || tag === undefined) throw new Error('invalid mfa secret');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, 'mfa-secret-v1'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]);
}

/** 回復コード（XXXX-XXXX）を作る */
export function generateRecoveryCodes(count = MFA_RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let s = '';
    for (let i = 0; i < 8; i += 1) s += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    codes.add(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return [...codes];
}

/** 回復コードの保存値（利用者ごとに異なる値にする） */
export function hashRecoveryCode(userId: string, normalizedCode: string, secret: string): string {
  return createHmac('sha256', key(secret, 'mfa-recovery-v1')).update(`${userId}|${normalizedCode}`).digest('base64url');
}

// ---------------------------------------------------------------- 確認待ち（challenge）

export interface MfaChallenge {
  readonly v: 1;
  readonly uid: string;
  /** 期限（ミリ秒） */
  readonly exp: number;
  /** パスワード確認時の利用者の authChangedAt（その後にパスワード再設定・停止などがあれば無効） */
  readonly acs: number;
  /** 登録中の秘密鍵（暗号文）。登録済みの利用者には無い */
  readonly pending?: string;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', key(secret, 'mfa-challenge-v1')).update(body).digest('base64url');
}

export function issueMfaChallenge(c: MfaChallenge, secret: string): string {
  const body = Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function verifyMfaChallenge(token: string, secret: string, nowMs: number): MfaChallenge | null {
  const [body, sig] = token.split('.');
  if (body === undefined || sig === undefined || token.split('.').length !== 2) return null;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<MfaChallenge>;
    if (c.v !== 1 || typeof c.uid !== 'string' || typeof c.exp !== 'number' || typeof c.acs !== 'number') return null;
    if (c.pending !== undefined && typeof c.pending !== 'string') return null;
    if (c.exp < nowMs) return null;
    return c as MfaChallenge;
  } catch {
    return null;
  }
}
