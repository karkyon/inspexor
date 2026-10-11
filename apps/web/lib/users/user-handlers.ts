/**
 * CHG-008 API-030〜033（/api/v1/users[/{id}[/{action}]]）。入口ガード（認証→CSRF→認可）は createApiHandler。
 * Zod で未知の項目を拒否し、UserService に渡す。パスワードは応答・ログに出さない。
 */
import { z, type ZodTypeAny } from 'zod';
import type { OperationId } from '@inspexor/domain';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';
import { ROLE_CODES, UserError, type UserAction, type UserService } from './user-service';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACTIONS: readonly UserAction[] = ['deactivate', 'activate', 'reset-password', 'unlock'];

export interface UserRouteDeps {
  readonly service: () => UserService;
  readonly api: () => ApiHandlerDeps;
}

const roles = z
  .array(z.enum(ROLE_CODES))
  .min(1, 'ロールを1つ以上選んでください')
  .refine((a) => new Set(a).size === a.length, 'ロールが重複しています');
const displayName = z.string().trim().min(1, '表示名を入力してください').max(100);
const password = z.string().min(12, 'パスワードは12文字以上にしてください').max(128);

export const userCreateSchema = z
  .object({
    loginId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$/, 'ログインIDは3〜100文字の英数字と . _ @ - で入力してください'),
    displayName,
    roles,
    password,
  })
  .strict();
export const userUpdateSchema = z.object({ expectedVersion: z.number().int().min(1), displayName, roles }).strict();
export const userCommandSchema = z
  .object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().max(1000).optional(), password: password.optional() })
  .strict();

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Array<{ path: string; code: string; message: string }>) {
    super(message);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。');
  }
}

function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): ReturnType<S['parse']> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RequestError(
      422,
      'VALIDATION_ERROR',
      '入力内容を確認してください。',
      parsed.error.issues.map((issue) => ({ path: `/${issue.path.map(String).join('/')}`, code: String(issue.code), message: zodIssueMessageJa(issue as unknown as ZodIssueLike) })),
    );
  }
  return parsed.data as ReturnType<S['parse']>;
}

function segments(request: Request): { id: string | null; action: string | null } {
  const seg = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const i = seg.indexOf('users');
  return { id: seg[i + 1] ?? null, action: seg[i + 2] ?? null };
}

function idOf(request: Request): string {
  const { id } = segments(request);
  if (id === null || !UUID_RE.test(id)) throw new RequestError(404, 'VALIDATION_ERROR', '利用者が見つかりません。', [{ path: '/id', code: 'not_found', message: '利用者が見つかりません。' }]);
  return id.toLowerCase();
}

function noQuery(request: Request): void {
  for (const key of new URL(request.url).searchParams.keys()) {
    throw new RequestError(400, 'VALIDATION_ERROR', `未知のquery parameterです: ${key}`, [{ path: `/query/${key}`, code: 'unknown', message: '未知のparameterです。' }]);
  }
}

function handler(operationId: OperationId, deps: UserRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
  return createApiHandler(
    operationId,
    async (ctx) => {
      try {
        return await body(ctx);
      } catch (error) {
        if (error instanceof RequestError || error instanceof UserError) {
          return errorResponse(error.status, error.code, error.message, ctx.correlationId, {
            ...(error.fields !== undefined && error.fields.length > 0 ? { fields: [...error.fields] } : {}),
            ...(error instanceof UserError && Object.keys(error.extra).length > 0 ? { extra: error.extra } : {}),
          });
        }
        throw error;
      }
    },
    deps.api,
  );
}

const ctxOf = (ctx: ApiContext) => ({ actorId: ctx.actor?.userId as string, correlationId: ctx.correlationId, now: ctx.now });

export function userCollectionHandlers(deps: UserRouteDeps) {
  return {
    GET: handler('listUsers', deps, async (ctx) => {
      noQuery(ctx.request);
      const users = await deps.service().list(ctx.now);
      return Response.json({ data: users, meta: { page: 1, pageSize: users.length, total: users.length } }, { status: 200, headers: { 'x-correlation-id': ctx.correlationId } });
    }),
    POST: handler('createUser', deps, async (ctx) => {
      noQuery(ctx.request);
      const input = parseBody(userCreateSchema, await readJson(ctx.request));
      return dataResponse(201, await deps.service().create(input, ctxOf(ctx)), ctx.correlationId);
    }),
  };
}

export function userItemHandlers(deps: UserRouteDeps) {
  return {
    PATCH: handler('updateUser', deps, async (ctx) => {
      const id = idOf(ctx.request);
      noQuery(ctx.request);
      const input = parseBody(userUpdateSchema, await readJson(ctx.request));
      return dataResponse(200, await deps.service().update(id, input, ctxOf(ctx)), ctx.correlationId);
    }),
  };
}

export function userActionHandlers(deps: UserRouteDeps) {
  return {
    POST: handler('userAction', deps, async (ctx) => {
      const id = idOf(ctx.request);
      const action = segments(ctx.request).action ?? '';
      if (!(ACTIONS as readonly string[]).includes(action)) {
        throw new RequestError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: `${ACTIONS.join(' / ')} のみ利用できます。` }]);
      }
      noQuery(ctx.request);
      const cmd = parseBody(userCommandSchema, await readJson(ctx.request));
      if (action === 'reset-password' && cmd.password === undefined) {
        throw new RequestError(422, 'VALIDATION_ERROR', '新しいパスワードを入力してください。', [{ path: '/password', code: 'required', message: '新しいパスワードを入力してください。' }]);
      }
      if (action !== 'reset-password' && cmd.password !== undefined) {
        throw new RequestError(422, 'VALIDATION_ERROR', 'パスワードは再設定のときだけ指定できます。', [{ path: '/password', code: 'unexpected', message: 'この操作では指定できません。' }]);
      }
      const reason = cmd.reason !== undefined && cmd.reason !== '' ? cmd.reason : null;
      return dataResponse(200, await deps.service().act(id, action as UserAction, { expectedVersion: cmd.expectedVersion, reason, password: cmd.password }, ctxOf(ctx)), ctx.correlationId);
    }),
  };
}
