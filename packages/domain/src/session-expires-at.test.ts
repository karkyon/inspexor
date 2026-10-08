import { describe, it, expect } from 'vitest';
import { sessionExpiresAt } from './session-policy';

describe('sessionExpiresAt: idle/absoluteの早い方', () => {
  it('発行直後はidle 30分後', () => {
    const t = new Date('2026-10-08T00:00:00Z');
    expect(sessionExpiresAt({ issuedAt: t, lastActivityAt: t }).toISOString()).toBe('2026-10-08T00:30:00.000Z');
  });
  it('absolute期限が近い場合はabsolute', () => {
    expect(
      sessionExpiresAt({
        issuedAt: new Date('2026-10-08T00:00:00Z'),
        lastActivityAt: new Date('2026-10-08T11:50:00Z'),
      }).toISOString(),
    ).toBe('2026-10-08T12:00:00.000Z');
  });
});
