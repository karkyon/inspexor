/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-003準拠。
 * 5回失敗で15分ロック、成功時はfailed_attemptsをresetする。
 * schema.sql app.users: failed_attempts int, locked_until timestamptz。
 */

export interface LockoutState {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MINUTES = 15;

export type LockoutCheckResult =
  | { readonly locked: false }
  | { readonly locked: true; readonly lockedUntil: Date };

export function checkLockout(state: LockoutState, now: Date): LockoutCheckResult {
  if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
    return { locked: true, lockedUntil: state.lockedUntil };
  }
  return { locked: false };
}

export function recordFailedAttempt(state: LockoutState, now: Date): LockoutState {
  const nextAttempts = state.failedAttempts + 1;
  if (nextAttempts >= LOCKOUT_THRESHOLD) {
    return {
      failedAttempts: nextAttempts,
      lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MINUTES * 60_000),
    };
  }
  return { failedAttempts: nextAttempts, lockedUntil: state.lockedUntil };
}

export function recordSuccessfulAttempt(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
