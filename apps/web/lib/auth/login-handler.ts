import { login, type LoginDeps, type UserRepository, type PasswordHasher } from '@inspexor/application';
import { sessionCookieAttributes, sessionExpiresAt } from '@inspexor/domain';
import { issueCsrfToken } from '../security/csrf';
import { resolveCorrelationId } from '../http/correlation-id';
import { errorResponse, dataResponse } from '../http/api-response';
import { loginRequestSchema } from './login-request-schema';
import { issueSessionToken, generateSessionId, type SessionPayload } from './session-token';
import { sessionCookieHeader } from './session-cookie';
import { rateLimitedResponse, type LoginRateLimit } from '../security/rate-limit';
import type { MfaChallengeView } from './mfa-service';

export interface LoginHandlerDeps {
  readonly userRepository: UserRepository;
  readonly passwordHasher: PasswordHasher;
  readonly sessionSecret: string;
  readonly now: () => Date;
  /** CHG-012: 回数制限（接続元・ログインID）。未指定なら数えない（試験） */
  readonly rateLimit?: LoginRateLimit;
  /** CHG-012: 管理者の多要素認証。必要なら確認待ちを返す。未指定なら多要素認証なし */
  readonly mfa?: { requiredFor(roles: readonly string[]): boolean; challengeFor(userId: string, now: Date): Promise<MfaChallengeView | null> };
}

/** session を発行して、ログイン成功の応答を返す（ログイン・確認コードの確認で共通） */
export function loginSuccessResponse(
  user: { userId: string; displayName: string; roles: readonly string[] },
  now: Date,
  sessionSecret: string,
  correlationId: string,
  options: { mfa?: boolean; recoveryCodes?: readonly string[] | null } = {},
): Response {
  const sessionPayload: SessionPayload = {
    sessionId: generateSessionId(),
    userId: user.userId,
    displayName: user.displayName,
    roles: [...user.roles],
    issuedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    authAt: now.toISOString(),
    ...(options.mfa === true ? { mfa: true } : {}),
  };
  const token = issueSessionToken(sessionPayload, sessionSecret);
  const csrfToken = issueCsrfToken(sessionPayload.sessionId, sessionSecret);
  const expiresAt = sessionExpiresAt({ issuedAt: now, lastActivityAt: now }).toISOString();
  // Session + csrfToken（GAP-009: CSRFトークンをログイン応答で配布）。CHG-012: 多要素認証の登録時だけ回復コードを一度だけ返す
  return dataResponse(
    200,
    {
      userId: user.userId,
      displayName: user.displayName,
      roles: [...user.roles],
      expiresAt,
      csrfToken,
      ...(options.recoveryCodes !== undefined && options.recoveryCodes !== null ? { recoveryCodes: [...options.recoveryCodes] } : {}),
    },
    correlationId,
    sessionCookieHeader(token, sessionCookieAttributes().maxAge),
  );
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
  // CHG-012: 回数制限（パスワードの照合より前）
  if (deps.rateLimit !== undefined) {
    const decision = await deps.rateLimit(request, parsed.data.loginId, now);
    if (!decision.ok) return rateLimitedResponse(decision.retryAfterSeconds, correlationId);
  }
  const loginDeps: LoginDeps = {
    userRepository: deps.userRepository,
    passwordHasher: deps.passwordHasher,
    now,
    // CHG-012: 多要素認証が必要な利用者は、確認コードまで済んでから失敗回数を戻す
    ...(deps.mfa !== undefined ? { deferLockoutReset: (u: { roles: readonly string[] }) => (deps.mfa as { requiredFor(r: readonly string[]): boolean }).requiredFor(u.roles) } : {}),
  };
  const result = await login(parsed.data, loginDeps);

  if (!result.ok) {
    // 存在秘匿: 詳細理由は返さない（FR-001失敗時要件）
    const status = result.errorCode === 'ACCOUNT_LOCKED' ? 423 : 401;
    return errorResponse(status, result.errorCode, '認証に失敗しました。', correlationId);
  }

  // CHG-012: 管理者の多要素認証。session はまだ出さず、確認待ちを返す
  const challenge = deps.mfa !== undefined ? await deps.mfa.challengeFor(result.userId, now) : null;
  if (challenge !== null) return dataResponse(200, challenge, correlationId);

  return loginSuccessResponse({ userId: result.userId, displayName: result.displayName, roles: result.roles }, now, deps.sessionSecret, correlationId);
}
