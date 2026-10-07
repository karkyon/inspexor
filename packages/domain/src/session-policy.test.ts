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
