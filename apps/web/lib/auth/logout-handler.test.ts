import { describe, it, expect } from 'vitest';
import { handleLogoutRequest } from './logout-handler';
import { issueSessionToken, type SessionPayload } from './session-token';
import { issueCsrfToken } from '../security/csrf';
import { SESSION_COOKIE_NAME } from './session-cookie';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-07T09:05:00.000Z');

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

function makeRequest(cookie: string | null, csrfToken: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  if (csrfToken !== null) {
    headers['x-csrf-token'] = csrfToken;
  }
  return new Request('https://example.com/api/auth/logout', { method: 'POST', headers });
}

describe('handleLogoutRequest', () => {
  it('有効なsession+正しいCSRFトークンで204、cookieを削除する', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const csrfToken = issueCsrfToken(payload.sessionId, SECRET);

    const response = await handleLogoutRequest(makeRequest(token, csrfToken), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('CSRFトークン無しは403 CSRF_INVALID', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);

    const response = await handleLogoutRequest(makeRequest(token, null), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('CSRF_INVALID');
  });

  it('別sessionId向けのCSRFトークンは403', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const wrongCsrf = issueCsrfToken('s-other', SECRET);

    const response = await handleLogoutRequest(makeRequest(token, wrongCsrf), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(403);
  });

  it('session cookie無しは401', async () => {
    const response = await handleLogoutRequest(makeRequest(null, null), {
      sessionSecret: SECRET,
      now: () => NOW,
    });
    expect(response.status).toBe(401);
  });
});
