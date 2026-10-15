/**
 * CHG-012 認証まわりの規則（framework 非依存）。
 *   SEC-009 / GAP-010 回数制限: ログイン（接続元・ログインID）／更新（利用者）／参照（利用者）の別 bucket。超えたら 429 RATE_LIMITED
 *   SEC-004 / G1-03 ADMIN の多要素認証（TOTP、回復コード）
 *   SEC-026 再認証: 代理入力・パスワード再設定・多要素認証の解除などの前に、直近 10 分以内の認証（パスワード＋必要なら確認コード）を求める
 */

export interface RateLimitRule {
  /** 1つの区間で許す回数 */
  readonly limit: number;
  /** 区間の長さ（ミリ秒、固定区間） */
  readonly windowMs: number;
}

export type RateLimitBucket = 'loginIp' | 'loginId' | 'command' | 'read';

/**
 * 既定値。ログインは同じ接続元から 10 分に 100 回、同じログインID に 10 分 30 回まで（パスワードの誤りは別に 5 回で 15 分ロック）。
 * 更新は利用者ごとに 1 分 120 回、参照は 1 分 600 回まで（通常の画面操作では届かない値）
 */
export const RATE_LIMITS: Readonly<Record<RateLimitBucket, RateLimitRule>> = {
  loginIp: { limit: 100, windowMs: 10 * 60_000 },
  loginId: { limit: 30, windowMs: 10 * 60_000 },
  command: { limit: 120, windowMs: 60_000 },
  read: { limit: 600, windowMs: 60_000 },
};

/** 固定区間の開始時刻（ミリ秒） */
export function rateWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export type RateDecision = { readonly ok: true; readonly remaining: number } | { readonly ok: false; readonly retryAfterSeconds: number };

/** 区間内で count 回目（1 始まり）の要求を許すか */
export function decideRate(count: number, rule: RateLimitRule, nowMs: number): RateDecision {
  if (count <= rule.limit) return { ok: true, remaining: rule.limit - count };
  const end = rateWindowStart(nowMs, rule.windowMs) + rule.windowMs;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((end - nowMs) / 1000)) };
}

// ---------------------------------------------------------------- 多要素認証・再認証

/** TOTP（RFC 6238）: 30 秒・6 桁・HMAC-SHA1。端末の時計のずれを前後 1 区間まで許す */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
/** 回復コードの数（1回ずつ使える。使った数は監査に残す） */
export const MFA_RECOVERY_CODE_COUNT = 10;
/** パスワード確認の後、確認コードを入れるまでの期限 */
export const MFA_CHALLENGE_MINUTES = 5;
/** 再認証が有効な時間 */
export const REAUTH_WINDOW_MINUTES = 10;

/** 6 桁の確認コード（空白・ハイフンは除いて判定） */
export function normalizeTotpCode(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/** 回復コード XXXX-XXXX（英大文字と数字。紛らわしい 0/O/1/I は使わない）。小文字・空白・ハイフンの有無は問わない */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function normalizeRecoveryCode(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  if (s.length !== 8) return null;
  for (const ch of s) if (!RECOVERY_CODE_ALPHABET.includes(ch)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 多要素認証が必要な利用者か（機能が有効で、管理者ロールを持つ） */
export function mfaRequiredFor(roles: readonly string[], adminMfaEnabled: boolean): boolean {
  return adminMfaEnabled && roles.includes('ADMIN');
}

/** 直近の認証から REAUTH_WINDOW_MINUTES 以内か */
export function isRecentAuth(authAt: Date, now: Date): boolean {
  const age = now.getTime() - authAt.getTime();
  return age >= -60_000 && age <= REAUTH_WINDOW_MINUTES * 60_000;
}
