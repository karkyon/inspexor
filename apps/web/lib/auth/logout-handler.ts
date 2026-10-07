import { checkSessionValidity } from '@inspexor/domain';
import { verifySessionToken } from './session-token';
import { verifyCsrfToken } from '../security/csrf';
import { readSessionCookie, clearSessionCookieHeader } from './session-cookie';

export interface LogoutHandlerDeps {
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

function csrfInvalid(correlationId: string): Response {
  return Response.json(
    { error: { code: 'CSRF_INVALID', message: 'CSRFトークンが無効です。', correlationId, retryable: false } },
    { status: 403 },
  );
}

export async function handleLogoutRequest(request: Request, deps: LogoutHandlerDeps): Promise<Response> {
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

  // SEC-005: state-changing API（logout）はCSRFトークン必須。X-CSRF-Tokenヘッダで受け取る。
  const csrfToken = request.headers.get('x-csrf-token');
  if (!csrfToken || !verifyCsrfToken(csrfToken, payload.sessionId, deps.sessionSecret)) {
    return csrfInvalid(correlationId);
  }

  const response = new Response(null, { status: 204, headers: { 'x-correlation-id': correlationId } });
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}
