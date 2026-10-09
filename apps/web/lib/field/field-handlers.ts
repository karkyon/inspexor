/**
 * API-004〜012（/api/v1/work-reports, /delivery-reports, /records）。
 * 入口ガード（認証→CSRF→認可→Idempotency-Key 形式）は createApiHandler、ここでは path/query → Zod（未知field拒否）
 * → FieldReportService（version → state → 業務制約）の順（ADR-0001）。
 * confirm（API-007/011）は Idempotency-Key で 24h 冪等（同key同payload=同応答、異payload=409）。
 */
import type { OperationId } from '@inspexor/domain';
import type { ZodTypeAny } from 'zod';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { errorResponse, dataResponse } from '../http/api-response';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';
import { PgIdempotencyRepository } from '../db/pg-idempotency-repository';
import type { Pool } from 'pg';
import { FieldError, type FieldContext, type FieldReportService, type FieldReportType } from './field-report-service';
import { deliveryDraftSchema, deliveryFeeSchema, deliveryUpdateSchema, fieldCommandSchema, workDraftSchema, workUpdateSchema } from './schemas';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_STATUSES = ['DRAFT', 'CONFIRMED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED', 'BILLING_LOCKED'];
const SEGMENT: Record<FieldReportType, string> = { WORK: 'work-reports', DELIVERY: 'delivery-reports' };
const LABEL: Record<FieldReportType, string> = { WORK: '作業日報', DELIVERY: '運搬実績' };

export interface FieldRouteDeps {
  readonly service: () => FieldReportService;
  readonly pool: () => Pool;
  readonly api: () => ApiHandlerDeps;
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Array<{ path: string; code: string; message: string }>) {
    super(message);
  }
}

function pathId(request: Request, type: FieldReportType): string {
  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.indexOf(SEGMENT[type]) + 1] ?? '';
  if (!UUID_RE.test(id)) {
    throw new RequestError(404, 'VALIDATION_ERROR', `${LABEL[type]}が見つかりません。`, [{ path: '/id', code: 'not_found', message: 'idが不正です。' }]);
  }
  return id.toLowerCase();
}

function rejectQuery(request: Request, allowed: readonly string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      throw new RequestError(400, 'VALIDATION_ERROR', `未知のquery parameterです: ${key}`, [{ path: `/query/${key}`, code: 'unknown', message: '未知のparameterです。' }]);
    }
  }
  return params;
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
      parsed.error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join('/')}`,
        code: String(issue.code),
        message: zodIssueMessageJa(issue as unknown as ZodIssueLike),
      })),
    );
  }
  return parsed.data as ReturnType<S['parse']>;
}

function ctxOf(ctx: ApiContext): FieldContext {
  if (ctx.actor === null) throw new Error('actor required');
  return { actor: { userId: ctx.actor.userId, roles: ctx.actor.roles }, correlationId: ctx.correlationId, now: ctx.now };
}

function toResponse(error: unknown, correlationId: string): Response {
  if (error instanceof RequestError || error instanceof FieldError) {
    return errorResponse(error.status, error.code, error.message, correlationId, {
      ...(error.fields !== undefined ? { fields: error.fields } : {}),
      ...(error instanceof FieldError && error.extra !== undefined ? { extra: error.extra } : {}),
    });
  }
  throw error;
}

function handler(operationId: OperationId, deps: FieldRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
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

function intParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) {
    throw new RequestError(400, 'VALIDATION_ERROR', `${key} は ${min}〜${max} の整数です。`, [{ path: `/query/${key}`, code: 'range', message: `${min}〜${max} の整数です。` }]);
  }
  return n;
}

function dateParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (!DATE_RE.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new RequestError(400, 'VALIDATION_ERROR', `${key} は YYYY-MM-DD です。`, [{ path: `/query/${key}`, code: 'format', message: 'YYYY-MM-DD 形式です。' }]);
  }
  return raw;
}

function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  if (!UUID_RE.test(raw)) {
    throw new RequestError(400, 'VALIDATION_ERROR', `${key} が不正です。`, [{ path: `/query/${key}`, code: 'format', message: 'uuid 形式です。' }]);
  }
  return raw.toLowerCase();
}

export function fieldCollectionHandlers(type: FieldReportType, deps: FieldRouteDeps) {
  return {
    POST: handler(type === 'WORK' ? 'createWorkReport' : 'createDeliveryReport', deps, async (ctx) => {
      rejectQuery(ctx.request, []);
      const body = await readJson(ctx.request);
      const record =
        type === 'WORK'
          ? await deps.service().createWork(parseBody(workDraftSchema, body), ctxOf(ctx))
          : await deps.service().createDelivery(parseBody(deliveryDraftSchema, body), ctxOf(ctx));
      return dataResponse(201, record, ctx.correlationId);
    }),
  };
}

export function fieldItemHandlers(type: FieldReportType, deps: FieldRouteDeps) {
  return {
    GET: handler(type === 'WORK' ? 'getWorkReport' : 'getDeliveryReport', deps, async (ctx) => {
      const id = pathId(ctx.request, type);
      rejectQuery(ctx.request, []);
      return dataResponse(200, await deps.service().get(type, id, ctxOf(ctx).actor), ctx.correlationId);
    }),
    PATCH: handler(type === 'WORK' ? 'updateWorkReport' : 'updateDeliveryReport', deps, async (ctx) => {
      const id = pathId(ctx.request, type);
      rejectQuery(ctx.request, []);
      const body = await readJson(ctx.request);
      const record =
        type === 'WORK'
          ? await deps.service().updateWork(id, parseBody(workUpdateSchema, body), ctxOf(ctx))
          : await deps.service().updateDelivery(id, parseBody(deliveryUpdateSchema, body), ctxOf(ctx));
      return dataResponse(200, record, ctx.correlationId);
    }),
  };
}

export function fieldConfirmHandlers(type: FieldReportType, deps: FieldRouteDeps) {
  return {
    POST: handler(type === 'WORK' ? 'confirmWorkReport' : 'confirmDeliveryReport', deps, async (ctx) => {
      const id = pathId(ctx.request, type);
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const cmd = parseBody(fieldCommandSchema, raw);
      const field = ctxOf(ctx);
      const route = `POST /${SEGMENT[type]}/${id}/confirm`;
      const repo = new PgIdempotencyRepository(deps.pool());
      const begin = await beginIdempotentRequest(
        repo,
        { actorId: field.actor.userId, route, key: ctx.idempotencyKey as string },
        computeRequestHash('POST', route, raw),
        ctx.now,
      );
      if (begin.kind === 'REPLAY') {
        return Response.json(begin.responseBody, { status: begin.responseStatus, headers: { 'x-correlation-id': ctx.correlationId, 'idempotent-replayed': 'true' } });
      }
      if (begin.kind === 'IN_PROGRESS') {
        return errorResponse(409, 'IDEMPOTENCY_CONFLICT', '同じ確定処理を実行中です。しばらくしてから再読込してください。', ctx.correlationId, { retryable: true });
      }
      if (begin.kind === 'CONFLICT') {
        return errorResponse(409, 'IDEMPOTENCY_CONFLICT', '同じ Idempotency-Key で異なる内容が送信されました。', ctx.correlationId);
      }
      try {
        const record = await deps.service().confirm(type, id, cmd.expectedVersion, field);
        const responseBody = { data: record, meta: null };
        await repo.complete(begin.recordId, 202, responseBody);
        return dataResponse(202, record, ctx.correlationId);
      } catch (error) {
        // 業務エラー・想定外とも、同じ key で入力を直して再送できるよう FAILED にする
        await repo.fail(begin.recordId).catch(() => undefined);
        throw error;
      }
    }),
  };
}

export function recordListHandlers(deps: FieldRouteDeps) {
  return {
    GET: handler('listRecords', deps, async (ctx) => {
      const q = rejectQuery(ctx.request, ['page', 'pageSize', 'status', 'dateFrom', 'dateTo', 'type', 'customerId', 'productId']);
      const status = q.get('status');
      if (status !== null && !RECORD_STATUSES.includes(status)) {
        throw new RequestError(400, 'VALIDATION_ERROR', 'status が不正です。', [{ path: '/query/status', code: 'enum', message: '未定義の状態です。' }]);
      }
      const type = q.get('type');
      if (type !== null && type !== 'WORK' && type !== 'DELIVERY') {
        throw new RequestError(400, 'VALIDATION_ERROR', 'type が不正です。', [{ path: '/query/type', code: 'enum', message: 'WORK / DELIVERY のいずれかです。' }]);
      }
      const result = await deps.service().list(ctxOf(ctx).actor, {
        page: intParam(q, 'page', 1, 1, 1_000_000),
        pageSize: intParam(q, 'pageSize', 25, 1, 100),
        status,
        dateFrom: dateParam(q, 'dateFrom'),
        dateTo: dateParam(q, 'dateTo'),
        type,
        customerId: uuidParam(q, 'customerId'),
        productId: uuidParam(q, 'productId'),
      });
      return Response.json(result, { status: 200, headers: { 'x-correlation-id': ctx.correlationId } });
    }),
  };
}

/**
 * API-013 transitionRecord（/records/{type}/{id}/{action}）。CHG-004: 承認（approve/reject/revoke）は対象外のため
 * 未定義の操作（404）とし、revise（確定後の事務所修正 D3、理由必須）だけを扱う。Idempotency-Key で冪等（GAP-011）。
 */
export function recordTransitionHandlers(deps: FieldRouteDeps) {
  return {
    POST: handler('transitionRecord', deps, async (ctx) => {
      rejectQuery(ctx.request, []);
      const seg = new URL(ctx.request.url).pathname.split('/').filter((x) => x.length > 0);
      const i = seg.indexOf('records');
      const typeRaw = seg[i + 1] ?? '';
      const id = seg[i + 2] ?? '';
      const action = seg[i + 3] ?? '';
      if ((typeRaw !== 'WORK' && typeRaw !== 'DELIVERY') || !UUID_RE.test(id)) {
        throw new RequestError(404, 'VALIDATION_ERROR', '報告が見つかりません。', [{ path: '/id', code: 'not_found', message: '報告が見つかりません。' }]);
      }
      if (action !== 'revise') {
        throw new RequestError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: 'revise のみ利用できます。' }]);
      }
      const type = typeRaw as FieldReportType;
      const raw = await readJson(ctx.request);
      const cmd = parseBody(fieldCommandSchema, raw);
      const reason = cmd.reason?.trim() ?? '';
      if (reason === '') {
        throw new RequestError(422, 'VALIDATION_ERROR', '修正理由を入力してください。', [{ path: '/reason', code: 'required', message: '確定済みの報告の修正は理由が必須です。' }]);
      }
      const field = ctxOf(ctx);
      const route = `POST /records/${type}/${id.toLowerCase()}/revise`;
      const repo = new PgIdempotencyRepository(deps.pool());
      const begin = await beginIdempotentRequest(repo, { actorId: field.actor.userId, route, key: ctx.idempotencyKey as string }, computeRequestHash('POST', route, raw), ctx.now);
      if (begin.kind === 'REPLAY') {
        return Response.json(begin.responseBody, { status: begin.responseStatus, headers: { 'x-correlation-id': ctx.correlationId, 'idempotent-replayed': 'true' } });
      }
      if (begin.kind !== 'PROCEED') {
        return errorResponse(409, 'IDEMPOTENCY_CONFLICT', begin.kind === 'IN_PROGRESS' ? '同じ操作を実行中です。' : '同じ Idempotency-Key で異なる内容が送信されました。', ctx.correlationId, { retryable: begin.kind === 'IN_PROGRESS' });
      }
      try {
        const record = await deps.service().revise(type, id.toLowerCase(), { expectedVersion: cmd.expectedVersion, reason }, field);
        await repo.complete(begin.recordId, 200, { data: record, meta: null });
        return dataResponse(200, record, ctx.correlationId);
      } catch (error) {
        await repo.fail(begin.recordId).catch(() => undefined);
        throw error;
      }
    }),
  };
}

/** CHG-004 D2: POST /delivery-reports/{id}/fee（運搬費の後入力・修正。OFFICE/ADMIN） */
export function deliveryFeeHandlers(deps: FieldRouteDeps) {
  return {
    POST: handler('setDeliveryFee', deps, async (ctx) => {
      const id = pathId(ctx.request, 'DELIVERY');
      rejectQuery(ctx.request, []);
      const cmd = parseBody(deliveryFeeSchema, await readJson(ctx.request));
      return dataResponse(200, await deps.service().setDeliveryFee(id, cmd, ctxOf(ctx)), ctx.correlationId);
    }),
  };
}
