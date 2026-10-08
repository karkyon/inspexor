/**
 * API-014〜018（/api/v1/masters/{type}[/{id}]）。入口ガード（認証→CSRF→認可）は createApiHandler、
 * ここでは path/query 解析 → Zod（未知field拒否）→ MasterService の順に処理する（ADR-0001）。
 */
import type { OperationId } from '@inspexor/domain';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { errorResponse, dataResponse } from '../http/api-response';
import { MASTER_DEFS, isMasterType, type MasterType } from './definitions';
import { writeSchema, updateSchema, commandSchema } from './schemas';
import { MasterError, type MasterService } from './master-service';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

interface ParsedPath {
  readonly type: MasterType;
  readonly id: string | null;
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Array<{ path: string; code: string; message: string }>) {
    super(message);
  }
}

function parsePath(request: Request, expectId: boolean): ParsedPath {
  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const i = segments.indexOf('masters');
  const type = segments[i + 1] ?? '';
  const id = segments[i + 2] ?? null;
  if (!isMasterType(type)) {
    throw new RequestError(404, 'VALIDATION_ERROR', 'マスタ種別が見つかりません。', [{ path: '/type', code: 'not_found', message: '未定義のマスタ種別です。' }]);
  }
  if (expectId && (id === null || !UUID_RE.test(id))) {
    throw new RequestError(404, 'VALIDATION_ERROR', `${MASTER_DEFS[type].label}が見つかりません。`, [{ path: '/id', code: 'not_found', message: 'idが不正です。' }]);
  }
  return { type, id: expectId ? id : null };
}

function parseQuery(request: Request, allowed: readonly string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      throw new RequestError(400, 'VALIDATION_ERROR', `未知のquery parameterです: ${key}`, [{ path: `/query/${key}`, code: 'unknown', message: '未知のparameterです。' }]);
    }
  }
  return params;
}

function intParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RequestError(400, 'VALIDATION_ERROR', `${key} は ${min}〜${max} の整数です。`, [{ path: `/query/${key}`, code: 'range', message: `${min}〜${max} の整数です。` }]);
  }
  return n;
}

function previewParam(params: URLSearchParams): boolean {
  const raw = params.get('preview');
  if (raw === null || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new RequestError(400, 'VALIDATION_ERROR', 'preview は true/false です。', [{ path: '/query/preview', code: 'enum', message: 'true/false です。' }]);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。');
  }
}

function zodFields(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: unknown; message: string }>) {
  return issues.map((issue) => ({
    path: `/${issue.path.map(String).join('/')}`,
    code: String(issue.code),
    message: zodIssueMessageJa(issue as unknown as ZodIssueLike),
  }));
}

function toResponse(error: unknown, correlationId: string): Response {
  if (error instanceof RequestError || error instanceof MasterError) {
    return errorResponse(error.status, error.code, error.message, correlationId, {
      ...(error.fields !== undefined ? { fields: error.fields } : {}),
      ...(error instanceof MasterError && error.extra !== undefined ? { extra: error.extra } : {}),
    });
  }
  throw error;
}

export interface MasterRouteDeps {
  readonly service: () => MasterService;
  readonly api: () => ApiHandlerDeps;
}

function actorId(ctx: ApiContext): string {
  if (ctx.actor === null) throw new Error('actor required');
  return ctx.actor.userId;
}

function handler(operationId: OperationId, deps: MasterRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
  return createApiHandler(
    operationId,
    async (ctx) => {
      try {
        return await body(ctx);
      } catch (error) {
        return toResponse(error, ctx.correlationId);
      }
    },
    deps.api,
  );
}

export function masterCollectionHandlers(deps: MasterRouteDeps) {
  return {
    GET: handler('listMasters', deps, async (ctx) => {
      const { type } = parsePath(ctx.request, false);
      const q = parseQuery(ctx.request, ['page', 'pageSize']);
      const page = intParam(q, 'page', 1, 1, 1_000_000);
      const pageSize = intParam(q, 'pageSize', 25, 1, 100);
      const result = await deps.service().list(type, page, pageSize);
      return Response.json(result, { status: 200 });
    }),
    POST: handler('createMaster', deps, async (ctx) => {
      const { type } = parsePath(ctx.request, false);
      parseQuery(ctx.request, []);
      const parsed = writeSchema(MASTER_DEFS[type]).safeParse(await readJson(ctx.request));
      if (!parsed.success) {
        return errorResponse(422, 'VALIDATION_ERROR', '入力値が不正です。', ctx.correlationId, { fields: zodFields(parsed.error.issues) });
      }
      const record = await deps.service().create(type, parsed.data as Record<string, unknown>, {
        actorId: actorId(ctx),
        correlationId: ctx.correlationId,
        now: ctx.now,
      });
      return dataResponse(201, record, ctx.correlationId);
    }),
  };
}

export function masterItemHandlers(deps: MasterRouteDeps) {
  return {
    GET: handler('getMaster', deps, async (ctx) => {
      const { type, id } = parsePath(ctx.request, true);
      parseQuery(ctx.request, []);
      return dataResponse(200, await deps.service().get(type, id as string), ctx.correlationId);
    }),
    PATCH: handler('updateMaster', deps, async (ctx) => {
      const { type, id } = parsePath(ctx.request, true);
      const preview = previewParam(parseQuery(ctx.request, ['preview']));
      const parsed = updateSchema(MASTER_DEFS[type]).safeParse(await readJson(ctx.request));
      if (!parsed.success) {
        return errorResponse(422, 'VALIDATION_ERROR', '入力値が不正です。', ctx.correlationId, { fields: zodFields(parsed.error.issues) });
      }
      const result = await deps.service().update(type, id as string, parsed.data as Record<string, unknown>, {
        actorId: actorId(ctx),
        correlationId: ctx.correlationId,
        now: ctx.now,
      }, preview);
      return dataResponse(200, result.kind === 'record' ? result.record : result.impact, ctx.correlationId);
    }),
    DELETE: handler('deactivateMaster', deps, async (ctx) => {
      const { type, id } = parsePath(ctx.request, true);
      const preview = previewParam(parseQuery(ctx.request, ['preview']));
      const parsed = commandSchema.safeParse(await readJson(ctx.request));
      if (!parsed.success) {
        return errorResponse(422, 'VALIDATION_ERROR', '入力値が不正です。', ctx.correlationId, { fields: zodFields(parsed.error.issues) });
      }
      const result = await deps.service().deactivate(type, id as string, parsed.data, {
        actorId: actorId(ctx),
        correlationId: ctx.correlationId,
        now: ctx.now,
      }, preview);
      if (result.kind === 'impact') {
        return dataResponse(200, result.impact, ctx.correlationId);
      }
      return new Response(null, { status: 204, headers: { 'x-correlation-id': ctx.correlationId } });
    }),
  };
}
