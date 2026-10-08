/**
 * API-024 GET /documents/{id}、API-025 POST /documents/{id}/{action}（Idempotency-Key 必須）。
 * 入口ガード（認証→CSRF→認可）は createApiHandler、ここでは path → Zod → DocumentService。
 */
import type { Pool } from 'pg';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';
import { PgIdempotencyRepository } from '../db/pg-idempotency-repository';
import { fieldCommandSchema } from '../field/schemas';
import { DOCUMENT_ACTIONS, DocumentError, type DocumentAction, type DocumentService } from './document-service';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface DocumentRouteDeps {
  readonly service: () => DocumentService;
  readonly pool: () => Pool;
  readonly api: () => ApiHandlerDeps;
}

function parsePath(request: Request, withAction: boolean): { id: string; action: DocumentAction | null } {
  const seg = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const i = seg.indexOf('documents');
  const id = seg[i + 1] ?? '';
  const action = seg[i + 2] ?? '';
  if (!UUID_RE.test(id)) throw new DocumentError(404, 'VALIDATION_ERROR', '帳票が見つかりません。', [{ path: '/id', code: 'not_found', message: 'idが不正です。' }]);
  if (withAction && !(DOCUMENT_ACTIONS as readonly string[]).includes(action)) {
    throw new DocumentError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: 'regenerate / send / retry のいずれかです。' }]);
  }
  if (new URL(request.url).searchParams.size > 0) {
    throw new DocumentError(400, 'VALIDATION_ERROR', '未知のquery parameterです。', [{ path: '/query', code: 'unknown', message: '未知のparameterです。' }]);
  }
  return { id: id.toLowerCase(), action: withAction ? (action as DocumentAction) : null };
}

function handler(operationId: 'getDocument' | 'documentAction', deps: DocumentRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
  return createApiHandler(
    operationId,
    async (ctx) => {
      try {
        return await body(ctx);
      } catch (error) {
        if (error instanceof DocumentError) {
          return errorResponse(error.status, error.code, error.message, ctx.correlationId, {
            ...(error.fields !== undefined ? { fields: error.fields } : {}),
            ...(error.extra !== undefined ? { extra: error.extra } : {}),
          });
        }
        throw error;
      }
    },
    deps.api,
  );
}

function actorOf(ctx: ApiContext) {
  if (ctx.actor === null) throw new Error('actor required');
  return { userId: ctx.actor.userId, roles: ctx.actor.roles };
}

export function documentItemHandlers(deps: DocumentRouteDeps) {
  return {
    GET: handler('getDocument', deps, async (ctx) => {
      const { id } = parsePath(ctx.request, false);
      return dataResponse(200, await deps.service().get(id, actorOf(ctx), ctx.now), ctx.correlationId);
    }),
  };
}

export function documentActionHandlers(deps: DocumentRouteDeps) {
  return {
    POST: handler('documentAction', deps, async (ctx) => {
      const { id, action } = parsePath(ctx.request, true);
      let raw: unknown;
      try {
        raw = await ctx.request.json();
      } catch {
        throw new DocumentError(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。');
      }
      const parsed = fieldCommandSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DocumentError(
          422,
          'VALIDATION_ERROR',
          '入力内容を確認してください。',
          parsed.error.issues.map((i) => ({ path: `/${i.path.map(String).join('/')}`, code: String(i.code), message: zodIssueMessageJa(i as unknown as ZodIssueLike) })),
        );
      }
      const actor = actorOf(ctx);
      const route = `POST /documents/${id}/${action}`;
      const repo = new PgIdempotencyRepository(deps.pool());
      const begin = await beginIdempotentRequest(repo, { actorId: actor.userId, route, key: ctx.idempotencyKey as string }, computeRequestHash('POST', route, raw), ctx.now);
      if (begin.kind === 'REPLAY') {
        return Response.json(begin.responseBody, { status: begin.responseStatus, headers: { 'x-correlation-id': ctx.correlationId, 'idempotent-replayed': 'true' } });
      }
      if (begin.kind !== 'PROCEED') {
        return errorResponse(409, 'IDEMPOTENCY_CONFLICT', begin.kind === 'IN_PROGRESS' ? '同じ操作を実行中です。' : '同じ Idempotency-Key で異なる内容が送信されました。', ctx.correlationId, { retryable: begin.kind === 'IN_PROGRESS' });
      }
      try {
        const result = await deps.service().action(id, action as DocumentAction, parsed.data, { actor, correlationId: ctx.correlationId, now: ctx.now });
        await repo.complete(begin.recordId, 202, { data: result, meta: null });
        return dataResponse(202, result, ctx.correlationId);
      } catch (error) {
        await repo.fail(begin.recordId).catch(() => undefined);
        throw error;
      }
    }),
  };
}
