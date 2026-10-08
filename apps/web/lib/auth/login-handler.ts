import { login, type LoginDeps, type UserRepository, type PasswordHasher } from '@inspexor/application';
import { sessionCookieAttributes, sessionExpiresAt } from '@inspexor/domain';
import { issueCsrfToken } from '../security/csrf';
import { resolveCorrelationId } from '../http/correlation-id';
import { errorResponse, dataResponse } from '../http/api-response';
import { loginRequestSchema } from './login-request-schema';
import { issueSessionToken, generateSessionId, type SessionPayload } from './session-token';
import { sessionCookieHeader } from './session-cookie';

export interface LoginHandlerDeps {
  readonly userRepository: UserRepository;
  readonly passwordHasher: PasswordHasher;
  readonly sessionSecret: string;
  readonly now: () => Date;
}

export async function handleLoginRequest(request: Request, deps: LoginHandlerDeps): Promise<Response> {
  const correlationId = resolveCorrelationId(request);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。', correlationId);
  }

  const parsed = loginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(422, 'VALIDATION_ERROR', '入力値が不正です。', correlationId, {
      fields: parsed.error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join('/')}`,
        code: String(issue.code),
        message: issue.message,
      })),
    });
  }

  const now = deps.now();
  const loginDeps: LoginDeps = {
    userRepository: deps.userRepository,
    passwordHasher: deps.passwordHasher,
    now,
  };
  const result = await login(parsed.data, loginDeps);

  if (!result.ok) {
    // 存在秘匿: 詳細理由は返さない（FR-001失敗時要件）
    const status = result.errorCode === 'ACCOUNT_LOCKED' ? 423 : 401;
    return errorResponse(status, result.errorCode, '認証に失敗しました。', correlationId);
  }

  const sessionPayload: SessionPayload = {
    sessionId: generateSessionId(),
    userId: result.userId,
    displayName: result.displayName,
    roles: result.roles,
    issuedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
  };
  const token = issueSessionToken(sessionPayload, deps.sessionSecret);
  const csrfToken = issueCsrfToken(sessionPayload.sessionId, deps.sessionSecret);
  const expiresAt = sessionExpiresAt({ issuedAt: now, lastActivityAt: now }).toISOString();

  // Session + csrfToken（GAP-009: CSRFトークンをログイン応答で配布）
  return dataResponse(
    200,
    { userId: result.userId, displayName: result.displayName, roles: result.roles, expiresAt, csrfToken },
    correlationId,
    sessionCookieHeader(token, sessionCookieAttributes().maxAge),
  );
}
