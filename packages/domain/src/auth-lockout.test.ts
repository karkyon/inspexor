import { describe, it, expect } from 'vitest';
import { checkLockout, recordFailedAttempt, recordSuccessfulAttempt, LOCKOUT_THRESHOLD } from './auth-lockout';

const NOW = new Date('2026-10-07T00:00:00Z');

describe('auth-lockout: SEC-003準拠（5回失敗/15分ロック）', () => {
  it('ロックなし状態はlocked:false', () => {
    expect(checkLockout({ failedAttempts: 0, lockedUntil: null }, NOW)).toEqual({ locked: false });
  });

  it('4回失敗まではロックしない', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      state = recordFailedAttempt(state, NOW);
    }
    expect(state.failedAttempts).toBe(4);
    expect(state.lockedUntil).toBeNull();
    expect(checkLockout(state, NOW)).toEqual({ locked: false });
  });

  it('5回目の失敗で15分ロックされる', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      state = recordFailedAttempt(state, NOW);
    }
    expect(state.failedAttempts).toBe(5);
    expect(state.lockedUntil).toEqual(new Date('2026-10-07T00:15:00Z'));
    const check = checkLockout(state, NOW);
    expect(check.locked).toBe(true);
  });

  it('ロック期限経過後はlocked:false', () => {
    const lockedState = { failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:15:00Z') };
    const after = new Date('2026-10-07T00:15:01Z');
    expect(checkLockout(lockedState, after)).toEqual({ locked: false });
  });

  it('成功時はfailedAttempts/lockedUntilがresetされる', () => {
    expect(recordSuccessfulAttempt()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});
