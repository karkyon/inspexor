import { describe, it, expect } from 'vitest';
import { interpretMeResponse } from './me-response';

describe('interpretMeResponse', () => {
  it('200 + 正しいdataはauthenticatedを返す', () => {
    const outcome = interpretMeResponse(200, {
      data: { userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'] },
    });
    expect(outcome.kind).toBe('authenticated');
  });

  it('401はunauthenticatedを返す', () => {
    const outcome = interpretMeResponse(401, { error: { code: 'AUTH_REQUIRED' } });
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  it('200だがdata形状不正はunauthenticated扱い（例外なし）', () => {
    expect(() => interpretMeResponse(200, {})).not.toThrow();
    expect(interpretMeResponse(200, {}).kind).toBe('unauthenticated');
  });

  it('bodyがnullでも例外を投げない', () => {
    expect(() => interpretMeResponse(500, null)).not.toThrow();
  });
});
