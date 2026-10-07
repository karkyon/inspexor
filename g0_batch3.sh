cd ~/inspexor

# ============================================================
# 1. packages/domain/src/session-policy.ts （SEC-001: idle30分/absolute12時間）
# ============================================================
cat > packages/domain/src/session-policy.ts << 'EOF'
/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-001準拠。
 * Session cookie: Secure/HttpOnly/SameSite=Lax、idle30分/absolute12時間。
 */

export const SESSION_IDLE_TIMEOUT_MINUTES = 30;
export const SESSION_ABSOLUTE_TIMEOUT_HOURS = 12;

export interface SessionTimestamps {
  readonly issuedAt: Date;
  readonly lastActivityAt: Date;
}

export type SessionValidityResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'IDLE_TIMEOUT' | 'ABSOLUTE_TIMEOUT' };

export function checkSessionValidity(timestamps: SessionTimestamps, now: Date): SessionValidityResult {
  const idleLimitMs = SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
  const absoluteLimitMs = SESSION_ABSOLUTE_TIMEOUT_HOURS * 60 * 60_000;

  if (now.getTime() - timestamps.issuedAt.getTime() > absoluteLimitMs) {
    return { valid: false, reason: 'ABSOLUTE_TIMEOUT' };
  }
  if (now.getTime() - timestamps.lastActivityAt.getTime() > idleLimitMs) {
    return { valid: false, reason: 'IDLE_TIMEOUT' };
  }
  return { valid: true };
}

/** cookieのmaxAge(秒)はabsolute timeoutを上限とする。 */
export function sessionCookieMaxAgeSeconds(): number {
  return SESSION_ABSOLUTE_TIMEOUT_HOURS * 60 * 60;
}

export interface SessionCookieAttributes {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

export function sessionCookieAttributes(): SessionCookieAttributes {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: sessionCookieMaxAgeSeconds() };
}
EOF

cat > packages/domain/src/session-policy.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { checkSessionValidity, sessionCookieMaxAgeSeconds, sessionCookieAttributes } from './session-policy';

const ISSUED = new Date('2026-10-07T00:00:00Z');

describe('session-policy: SEC-001準拠（idle30分/absolute12時間）', () => {
  it('発行直後は有効', () => {
    const r = checkSessionValidity({ issuedAt: ISSUED, lastActivityAt: ISSUED }, ISSUED);
    expect(r).toEqual({ valid: true });
  });

  it('idle30分未満は有効', () => {
    const lastActivity = new Date('2026-10-07T00:10:00Z');
    const now = new Date('2026-10-07T00:39:00Z');
    expect(checkSessionValidity({ issuedAt: ISSUED, lastActivityAt: lastActivity }, now)).toEqual({ valid: true });
  });

  it('idle30分超過はIDLE_TIMEOUT', () => {
    const lastActivity = new Date('2026-10-07T00:10:00Z');
    const now = new Date('2026-10-07T00:41:00Z');
    expect(checkSessionValidity({ issuedAt: ISSUED, lastActivityAt: lastActivity }, now)).toEqual({ valid: false, reason: 'IDLE_TIMEOUT' });
  });

  it('absolute12時間超過はABSOLUTE_TIMEOUT（idle内でも）', () => {
    const now = new Date('2026-10-07T12:01:00Z');
    const lastActivity = new Date('2026-10-07T11:55:00Z');
    expect(checkSessionValidity({ issuedAt: ISSUED, lastActivityAt: lastActivity }, now)).toEqual({ valid: false, reason: 'ABSOLUTE_TIMEOUT' });
  });

  it('cookie maxAgeは12時間(秒)', () => {
    expect(sessionCookieMaxAgeSeconds()).toBe(12 * 60 * 60);
  });

  it('cookie属性はSEC-001準拠', () => {
    expect(sessionCookieAttributes()).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 43200 });
  });
});
EOF

cat > packages/domain/src/index.ts << 'EOF'
export * from './money';
export * from './business-time';
export * from './rate-calculation';
export * from './transport-allocation';
export * from './tax';
export * from './record-status';
export * from './billing-status';
export * from './error-codes';
export * from './idempotency';
export * from './auth-lockout';
export * from './session-policy';
EOF

# ============================================================
# 2. apps/web: 依存追加（argon2 + @inspexor/application workspace参照 + test基盤）
# ============================================================
cd apps/web
pnpm add argon2@^0.31.2
pnpm add "@inspexor/application@workspace:*" "@inspexor/domain@workspace:*"
pnpm add -D vitest@^2.1.3
cd ~/inspexor

# ============================================================
# 3. apps/web/lib/security/csrf.ts
# ============================================================
mkdir -p apps/web/lib/security apps/web/lib/auth
cat > apps/web/lib/security/csrf.ts << 'EOF'
/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-005準拠。
 * 全state-changing API（command）はCSRF token必須。
 *
 * 方式: HMAC-based double-submit token。
 * token = base64url(nonce) + '.' + base64url(HMAC-SHA256(secret, sessionId + '.' + nonce))
 * サーバーはAUTH_SECRET等のsecretとsessionIdのみを保持し、tokenはクライアントに
 * 返却してリクエストヘッダ（例: X-CSRF-Token）で往復させる。secret自体はclientへ渡さない。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NONCE_BYTES = 18;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function hmac(secret: string, sessionId: string, nonce: string): Buffer {
  return createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest();
}

export function issueCsrfToken(sessionId: string, secret: string): string {
  const nonce = base64url(randomBytes(NONCE_BYTES));
  const signature = base64url(hmac(secret, sessionId, nonce));
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(token: string, sessionId: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [nonce, signature] = parts;
  if (!nonce || !signature) {
    return false;
  }
  const expected = base64url(hmac(secret, sessionId, nonce));
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
EOF

cat > apps/web/lib/security/csrf.test.ts << 'EOF'
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
EOF

# ============================================================
# 4. apps/web/lib/auth/argon2-password-hasher.ts
# ============================================================
cat > apps/web/lib/auth/argon2-password-hasher.ts << 'EOF'
/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-002準拠。
 * Argon2id、8-128文字。漏えいpassword照合（HaveIBeenPwned等）は外部依存のため
 * 未実装・GAP（DEPENDENCY_UNAVAILABLE対応含め別途設計要）。
 *
 * module境界（開発スタック定義書 §5）準拠: provider SDK(argon2)を直接importしてよいのは
 * apps/web側のadapter層のみ。packages/application/@inspexor/domainはこのportを介して利用する。
 */
import * as argon2 from 'argon2';
import type { PasswordHasher } from '@inspexor/application';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plainPassword: string): Promise<string> {
    if (plainPassword.length < PASSWORD_MIN_LENGTH || plainPassword.length > PASSWORD_MAX_LENGTH) {
      throw new Error(`passwordは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字である必要があります。`);
    }
    return argon2.hash(plainPassword, { type: argon2.argon2id });
  }

  async verify(plainPassword: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // 不正なhash形式等はverify失敗として扱う（内部エラーを漏らさない、SEC-010準拠）
      return false;
    }
  }
}
EOF

cat > apps/web/lib/auth/argon2-password-hasher.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher: SEC-002準拠', () => {
  it('正しいpasswordはverify成功', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('誤ったpasswordはverify失敗', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(await hasher.verify('wrong-password', hash)).toBe(false);
  });

  it('不正なhash文字列はverify失敗（例外を投げない）', async () => {
    const hasher = new Argon2PasswordHasher();
    expect(await hasher.verify('anything', 'not-a-valid-hash')).toBe(false);
  });

  it('8文字未満のpasswordはhash時に拒否', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.hash('short')).rejects.toThrow();
  });

  it('128文字超のpasswordはhash時に拒否', async () => {
    const hasher = new Argon2PasswordHasher();
    await expect(hasher.hash('a'.repeat(129))).rejects.toThrow();
  });
}, 20000);
EOF

# ============================================================
# 5. インストール＋検証
# ============================================================
pnpm install

echo "=== domain: tsc --noEmit ==="
(cd packages/domain && npx tsc --noEmit) && echo "TSC: PASS"

echo "=== domain: vitest run ==="
(cd packages/domain && npx vitest run)

echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit) && echo "TSC: PASS"

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
