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
