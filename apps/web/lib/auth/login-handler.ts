import { ZodError } from 'zod';
import { login, type LoginDeps, type UserRepository, type PasswordHasher } from '@inspexor/application';
import { sessionCookieAttributes } from '@inspexor/domain';
import { issueCsrfToken } from '../security/csrf';
import { loginRequestSchema } from './login-request-schema';
import { issueSessionToken, generateSessionId, type SessionPayload } from './session-token';
import { sessionCookieHeader } from './session-cookie';

export interface LoginHandlerDeps {
  readonly userRepository: UserRepository;
  readonly passwordHasher: PasswordHasher;
  readonly sessionSecret: string;
  readonly now: () => Date;
}

function errorResponse(status: number, code: string, message: string, correlationId: string): Response {
  return Response.json({ error: { code, message, correlationId, retryable: false } }, { status });
}

export async function handleLoginRequest(request: Request, deps: LoginHandlerDeps): Promise<Response> {
  const correlationId = request.headers.get('x-correlation-id') ?? generateSessionId();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。', correlationId);
  }

  const parsed = loginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const zodError: ZodError = parsed.error;
    return Response.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です。',
          fields: zodError.issues.map((issue) => ({
            path: `/${issue.path.join('/')}`,
            message: issue.message,
          })),
          correlationId,
          retryable: false,
        },
      },
      { status: 422 },
    );
  }

  const now = deps.now();
  const loginDeps: LoginDeps = {
    userRepository: deps.userRepository,
    passwordHasher: deps.passwordHasher,
    now,
  };

  const result = await login(parsed.data, loginDeps);

  if (!result.ok) {
    // 存在秘匿: AUTH_REQUIRED/ACCOUNT_LOCKEDいずれも詳細を返さない（FR-001失敗時要件）。
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
  const cookieAttrs = sessionCookieAttributes();
  const csrfToken = issueCsrfToken(sessionPayload.sessionId, deps.sessionSecret);

  const response = Response.json(
    {
      data: {
        userId: result.userId,
        displayName: result.displayName,
        roles: result.roles,
        csrfToken,
      },
      meta: null,
    },
    { status: 200, headers: { 'x-correlation-id': correlationId } },
  );
  response.headers.append('Set-Cookie', sessionCookieHeader(token, cookieAttrs.maxAge));
  return response;
}
