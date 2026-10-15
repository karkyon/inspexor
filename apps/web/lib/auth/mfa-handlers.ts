/**
 * CHG-012 多要素認証・再認証の API。
 *   API-038 POST /auth/mfa/setup            （公開）確認待ち → 秘密鍵と QR コード（未登録の管理者）
 *   API-039 POST /auth/mfa/verify           （公開）確認待ち＋確認コード（または回復コード）→ session
 *   API-040 POST /auth/reauth               （ログイン中）パスワード＋（登録者は）確認コード → session の認証時刻を更新
 *   API-041 GET  /auth/mfa                  （ログイン中）本人の多要素認証の状態
 *   API-042 POST /auth/mfa/recovery-codes   （管理者・再認証が必要）回復コードの再発行
 * 確認待ち・再認証は回数制限（接続元・確認待ち／利用者ごと）を受ける。秘密鍵・コードは記録しない
 */
import { z } from 'zod';
import { REAUTH_WINDOW_MINUTES } from '@inspexor/domain';
import { reauthRequiredResponse } from './reauth';
import type { PasswordHasher } from '@inspexor/application';
import { resolveCorrelationId } from '../http/correlation-id';
import { dataResponse, errorResponse } from '../http/api-response';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { rateLimitedResponse, type LoginRateLimit } from '../security/rate-limit';
import { loginSuccessResponse } from './login-handler';
import { MfaError, type MfaService } from './mfa-service';
import { issueSessionToken } from './session-token';
import { sessionCookieHeader } from './session-cookie';
import { sessionCookieAttributes } from '@inspexor/domain';

export interface MfaPublicDeps {
  readonly service: () => MfaService;
  readonly sessionSecret: () => string;
  readonly now: () => Date;
  readonly rateLimit?: LoginRateLimit;
}

const challenge = z.string().min(20).max(4000);
const code = z.string().trim().min(1).max(20);
export const mfaSetupSchema = z.object({ challenge }).strict();
export const mfaVerifySchema = z
  .object({ challenge, code: code.optional(), recoveryCode: code.optional() })
  .strict()
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), { message: '確認コードか回復コードのどちらか1つを入力してください。', path: ['code'] });
export const reauthSchema = z
  .object({ password: z.string().min(1).max(128), code: code.optional(), recoveryCode: code.optional() })
  .strict()
  .refine((v) => v.code === undefined || v.recoveryCode === undefined, { message: '確認コードか回復コードのどちらか1つを入力してください。', path: ['code'] });

function mfaErrorResponse(error: MfaError, correlationId: string): Response {
  return errorResponse(error.status, error.code, error.message, correlationId, {
    ...(error.fields.length > 0 ? { fields: [...error.fields] } : {}),
    ...(Object.keys(error.extra).length > 0 ? { extra: error.extra } : {}),
  });
}

async function readBody<S extends z.ZodTypeAny>(request: Request, schema: S, correlationId: string): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, res: errorResponse(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。', correlationId) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: errorResponse(422, 'VALIDATION_ERROR', '入力内容を確認してください。', correlationId, {
        fields: parsed.error.issues.map((i) => ({ path: `/${i.path.map(String).join('/')}`, code: String(i.code), message: i.message })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** 確認待ちの値ごと・接続元ごとに数える */
async function limited(deps: MfaPublicDeps, request: Request, token: string, now: Date, correlationId: string): Promise<Response | null> {
  if (deps.rateLimit === undefined) return null;
  const d = await deps.rateLimit(request, `mfa:${token.split('.')[0] ?? ''}`, now);
  return d.ok ? null : rateLimitedResponse(d.retryAfterSeconds, correlationId);
}

export async function handleMfaSetup(request: Request, deps: MfaPublicDeps): Promise<Response> {
  const correlationId = resolveCorrelationId(request);
  const body = await readBody(request, mfaSetupSchema, correlationId);
  if (!body.ok) return body.res;
  const now = deps.now();
  const rl = await limited(deps, request, body.data.challenge, now, correlationId);
  if (rl !== null) return rl;
  try {
    return dataResponse(200, await deps.service().setup(body.data.challenge, now), correlationId);
  } catch (error) {
    if (error instanceof MfaError) return mfaErrorResponse(error, correlationId);
    throw error;
  }
}

export async function handleMfaVerify(request: Request, deps: MfaPublicDeps): Promise<Response> {
  const correlationId = resolveCorrelationId(request);
  const body = await readBody(request, mfaVerifySchema, correlationId);
  if (!body.ok) return body.res;
  const now = deps.now();
  const rl = await limited(deps, request, body.data.challenge, now, correlationId);
  if (rl !== null) return rl;
  try {
    const r = await deps.service().verify(body.data.challenge, { code: body.data.code, recoveryCode: body.data.recoveryCode }, now, correlationId);
    return loginSuccessResponse({ userId: r.user.id, displayName: r.user.displayName, roles: r.user.roles }, now, deps.sessionSecret(), correlationId, { mfa: true, recoveryCodes: r.recoveryCodes });
  } catch (error) {
    if (error instanceof MfaError) return mfaErrorResponse(error, correlationId);
    throw error;
  }
}

// ---------------------------------------------------------------- ログイン中の操作

export interface MfaAccountDeps {
  readonly service: () => MfaService;
  readonly hasher: () => PasswordHasher;
  readonly api: () => ApiHandlerDeps;
  readonly rateLimit?: LoginRateLimit;
}

export { reauthRequiredResponse };

function wrap(fn: (ctx: ApiContext) => Promise<Response>) {
  return async (ctx: ApiContext): Promise<Response> => {
    try {
      return await fn(ctx);
    } catch (error) {
      if (error instanceof MfaError) return mfaErrorResponse(error, ctx.correlationId);
      throw error;
    }
  };
}

export function mfaAccountHandlers(deps: MfaAccountDeps) {
  return {
    status: createApiHandler(
      'getMfaStatus',
      wrap(async (ctx) => dataResponse(200, await deps.service().status(ctx.actor?.userId as string), ctx.correlationId)),
      deps.api,
    ),
    reauth: createApiHandler(
      'reauthenticate',
      wrap(async (ctx) => {
        const body = await readBody(ctx.request, reauthSchema, ctx.correlationId);
        if (!body.ok) return body.res;
        const session = ctx.session;
        if (session === null) return errorResponse(401, 'AUTH_REQUIRED', '認証が必要です。', ctx.correlationId);
        if (deps.rateLimit !== undefined) {
          const d = await deps.rateLimit(ctx.request, `reauth:${session.userId}`, ctx.now);
          if (!d.ok) return rateLimitedResponse(d.retryAfterSeconds, ctx.correlationId);
        }
        await deps.service().reauthenticate(session.userId, body.data.password, { code: body.data.code, recoveryCode: body.data.recoveryCode }, deps.hasher(), ctx.now, ctx.correlationId);
        const next = { ...session, authAt: ctx.now.toISOString(), lastActivityAt: ctx.now.toISOString() };
        const until = new Date(ctx.now.getTime() + REAUTH_WINDOW_MINUTES * 60_000).toISOString();
        return dataResponse(200, { authAt: next.authAt, reauthExpiresAt: until }, ctx.correlationId, sessionCookieHeader(issueSessionToken(next, deps.api().sessionSecret), sessionCookieAttributes().maxAge));
      }),
      deps.api,
    ),
    regenerate: createApiHandler(
      'regenerateRecoveryCodes',
      wrap(async (ctx) => {
        const reauth = reauthRequiredResponse(ctx);
        if (reauth !== null) return reauth;
        const codes = await deps.service().regenerateRecoveryCodes(ctx.actor?.userId as string, ctx.now, ctx.correlationId);
        return dataResponse(200, { recoveryCodes: codes }, ctx.correlationId);
      }),
      deps.api,
    ),
  };
}
