import { checkSessionValidity, sessionCookieAttributes } from '@inspexor/domain';
import { verifySessionToken, issueSessionToken, refreshLastActivity } from './session-token';
import { readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from './session-cookie';

export interface MeHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
}

function unauthenticated(correlationId: string): Response {
  const response = Response.json(
    { error: { code: 'AUTH_REQUIRED', message: '認証が必要です。', correlationId, retryable: false } },
    { status: 401 },
  );
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}

export async function handleMeRequest(request: Request, deps: MeHandlerDeps): Promise<Response> {
  const correlationId = request.headers.get('x-correlation-id') ?? 'no-correlation-id';
  const token = readSessionCookie(request);
  if (!token) {
    return unauthenticated(correlationId);
  }

  const payload = verifySessionToken(token, deps.sessionSecret);
  if (!payload) {
    return unauthenticated(correlationId);
  }

  const now = deps.now();
  const validity = checkSessionValidity(
    { issuedAt: new Date(payload.issuedAt), lastActivityAt: new Date(payload.lastActivityAt) },
    now,
  );
  if (!validity.valid) {
    return unauthenticated(correlationId);
  }

  const refreshed = refreshLastActivity(payload, now);
  const refreshedToken = issueSessionToken(refreshed, deps.sessionSecret);
  const cookieAttrs = sessionCookieAttributes();

  const response = Response.json(
    {
      data: { userId: payload.userId, displayName: payload.displayName, roles: payload.roles },
      meta: null,
    },
    { status: 200, headers: { 'x-correlation-id': correlationId } },
  );
  response.headers.append('Set-Cookie', sessionCookieHeader(refreshedToken, cookieAttrs.maxAge));
  return response;
}
