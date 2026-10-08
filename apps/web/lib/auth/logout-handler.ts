import { checkSessionValidity } from '@inspexor/domain';
import { verifyCsrfToken } from '../security/csrf';
import { resolveCorrelationId, CORRELATION_ID_HEADER } from '../http/correlation-id';
import { errorResponse } from '../http/api-response';
import { verifySessionToken } from './session-token';
import { readSessionCookie, clearSessionCookieHeader } from './session-cookie';

export interface LogoutHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
}

export async function handleLogoutRequest(request: Request, deps: LogoutHandlerDeps): Promise<Response> {
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
  const valid = checkSessionValidity(
    { issuedAt: new Date(payload.issuedAt), lastActivityAt: new Date(payload.lastActivityAt) },
    deps.now(),
  ).valid;
  if (!valid) {
    return unauthenticated();
  }

  // 00契約 不変条件2: 認証 → CSRF の順。SEC-005: state-changing APIはCSRF必須
  const csrfToken = request.headers.get('x-csrf-token');
  if (!csrfToken || !verifyCsrfToken(csrfToken, payload.sessionId, deps.sessionSecret)) {
    return errorResponse(403, 'CSRF_INVALID', 'CSRFトークンが無効です。', correlationId);
  }

  const response = new Response(null, { status: 204, headers: { [CORRELATION_ID_HEADER]: correlationId } });
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}
