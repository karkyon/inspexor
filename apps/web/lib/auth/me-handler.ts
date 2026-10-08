import { checkSessionValidity, sessionCookieAttributes, sessionExpiresAt } from '@inspexor/domain';
import { resolveCorrelationId } from '../http/correlation-id';
import { errorResponse, dataResponse } from '../http/api-response';
import { verifySessionToken, issueSessionToken, refreshLastActivity } from './session-token';
import { readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from './session-cookie';

export interface MeHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
}

export async function handleMeRequest(request: Request, deps: MeHandlerDeps): Promise<Response> {
  const correlationId = resolveCorrelationId(request);
  const unauthenticated = (): Response =>
    errorResponse(401, 'AUTH_REQUIRED', '認証が必要です。', correlationId, { setCookie: clearSessionCookieHeader() });

  const token = readSessionCookie(request);
  if (!token) {
    return unauthenticated();
  }
  const payload = verifySessionToken(token, deps.sessionSecret);
  if (!payload) {
    return unauthenticated();
  }

  const now = deps.now();
  const issuedAt = new Date(payload.issuedAt);
  if (!checkSessionValidity({ issuedAt, lastActivityAt: new Date(payload.lastActivityAt) }, now).valid) {
    return unauthenticated();
  }

  const refreshed = refreshLastActivity(payload, now);
  const expiresAt = sessionExpiresAt({ issuedAt, lastActivityAt: now }).toISOString();
  return dataResponse(
    200,
    { userId: payload.userId, displayName: payload.displayName, roles: payload.roles, expiresAt },
    correlationId,
    sessionCookieHeader(issueSessionToken(refreshed, deps.sessionSecret), sessionCookieAttributes().maxAge),
  );
}
