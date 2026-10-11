import { checkSessionValidity, featureFlags, sessionCookieAttributes, sessionExpiresAt } from '@inspexor/domain';
import { resolveCorrelationId } from '../http/correlation-id';
import { issueCsrfToken } from '../security/csrf';
import { errorResponse, dataResponse } from '../http/api-response';
import { verifySessionToken, issueSessionToken, refreshLastActivity } from './session-token';
import { readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from './session-cookie';

export interface MeHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
  /** CHG-007: 機能の有効化設定の参照元（試験用。既定は process.env） */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    // GAP-009: 再読込・別タブでも command を送れるよう、session に紐づく CSRF token を再発行して返す
    {
      userId: payload.userId,
      displayName: payload.displayName,
      roles: payload.roles,
      expiresAt,
      csrfToken: issueCsrfToken(payload.sessionId, deps.sessionSecret),
      // CHG-007: 画面の出し分け用（提案書の対象外機能は既定で無効）
      features: featureFlags(deps.env ?? process.env),
    },
    correlationId,
    sessionCookieHeader(issueSessionToken(refreshed, deps.sessionSecret), sessionCookieAttributes().maxAge),
  );
}
