import { describe, it, expect } from 'vitest';
import { handleMeRequest } from './me-handler';
import { issueSessionToken, type SessionPayload } from './session-token';
import { SESSION_COOKIE_NAME } from './session-cookie';

const SECRET = 'a'.repeat(32);

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 's-1',
    userId: 'u-1',
    displayName: '田中太郎',
    roles: ['OFFICE'],
    issuedAt: '2026-10-07T09:00:00.000Z',
    lastActivityAt: '2026-10-07T09:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(cookie: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  return new Request('https://example.com/api/me', { headers });
}

describe('handleMeRequest', () => {
  it('有効なsessionで200を返し、Set-CookieでlastActivityAtが更新される', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T09:05:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data).toEqual({ userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'] });
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('cookie無しは401', async () => {
    const response = await handleMeRequest(makeRequest(null), {
      sessionSecret: SECRET,
      now: () => new Date(),
    });
    expect(response.status).toBe(401);
  });

  it('改ざんされたtokenは401', async () => {
    const response = await handleMeRequest(makeRequest('tampered.token'), {
      sessionSecret: SECRET,
      now: () => new Date(),
    });
    expect(response.status).toBe(401);
  });

  it('idle30分超過は401（IDLE_TIMEOUT）', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T09:31:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });
    expect(response.status).toBe(401);
  });

  it('absolute12時間超過は401（ABSOLUTE_TIMEOUT）', async () => {
    const payload = makePayload({ lastActivityAt: '2026-10-07T20:59:00.000Z' });
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T21:01:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });
    expect(response.status).toBe(401);
  });
});
