/**
 * CHG-009 API-019 createBillingRun / API-020 getBillingRun / API-021 transitionBillingRun / API-034 listBillingRuns（/api/v1/billing-runs）。
 * 請求機能（BILLING_ENABLED、APPROVAL_ENABLED も必要）が無効なら 404（提案書の対象外: Blind）。
 * 入口ガード（認証→CSRF→認可→Idempotency-Key 形式）は createApiHandler、ここでは path/query → Zod（未知field拒否）→ BillingService。
 * 作成・遷移は Idempotency-Key で 24h 冪等（同key同payload=同応答、異payload=409）。
 * CHG-011: API-022 getInvoice / API-023 transitionInvoice（/api/v1/invoices）、
 *          API-035 listBillingAdjustments / API-036 createBillingAdjustment / API-037 cancelBillingAdjustment（/api/v1/billing-adjustments）。
 */
import { featureFlags, INVOICE_ACTIONS, type AdjustmentStatus, type InvoiceAction, type OperationId } from '@inspexor/domain';
import type { IdempotencyRepository } from '@inspexor/application';
import type { BillingRunStatus } from '@inspexor/docstore';
import { z, type ZodTypeAny } from 'zod';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';
import type { AdjustmentService } from './adjustment-service';
import { BillingError, type BillingContext, type BillingService } from './billing-service';
import type { InvoiceService } from './invoice-service';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly BillingRunStatus[] = ['OPEN', 'CALCULATING', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED', 'FINALIZED', 'ISSUED', 'SENT', 'VOIDED'];
const ACTIONS = ['calculate', 'review', 'finalize', 'void'] as const;
type Action = (typeof ACTIONS)[number];

export interface BillingRouteDeps {
  readonly service: () => BillingService;
  /** CHG-011 */
  readonly invoices: () => InvoiceService;
  readonly adjustments: () => AdjustmentService;
  readonly idempotency: () => IdempotencyRepository;
  readonly api: () => ApiHandlerDeps;
  /** 機能の有効化設定の参照元（試験用。既定は process.env） */
  readonly env?: () => Readonly<Record<string, string | undefined>>;
}

const createSchema = z
  .object({
    customerId: z.string().regex(UUID_RE, 'uuid形式ではありません'),
    periodEnd: z.string().regex(DATE_RE, 'YYYY-MM-DD形式の日付ではありません'),
  })
  .strict();
const commandSchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().max(1000).optional() }).strict();
const reviewSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(1, 'レビューの理由を入力してください。').max(1000),
    resolutions: z.array(z.object({ warningId: z.string().min(1).max(300), resolution: z.enum(['ACCEPT', 'EXCLUDE']) }).strict()).max(1000),
  })
  .strict();

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Array<{ path: string; code: string; message: string }>) {
    super(message);
  }
}

function segmentsAfter(request: Request, collection = 'billing-runs'): string[] {
  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  return segments.slice(segments.indexOf(collection) + 1);
}

function idOf(request: Request, collection: string, label: string): string {
  const id = segmentsAfter(request, collection)[0] ?? '';
  if (!UUID_RE.test(id)) throw new RequestError(404, 'VALIDATION_ERROR', `${label}が見つかりません。`, [{ path: '/id', code: 'not_found', message: 'idが不正です。' }]);
  return id.toLowerCase();
}

const adjustmentCreateSchema = z
  .object({
    sourceInvoiceId: z.string().regex(UUID_RE, 'uuid形式ではありません'),
    productId: z.string().regex(UUID_RE, 'uuid形式ではありません'),
    sourceReportId: z.string().regex(UUID_RE, 'uuid形式ではありません').nullable().optional(),
    description: z.string().trim().min(1, '内容を入力してください。').max(200),
    amountYen: z.number().int(),
    reason: z.string().trim().min(1, '調整の理由を入力してください。').max(1000),
  })
  .strict();
const ADJUSTMENT_STATUSES: readonly AdjustmentStatus[] = ['PENDING', 'APPLIED', 'CANCELLED'];

function runId(request: Request): string {
  const id = segmentsAfter(request)[0] ?? '';
  if (!UUID_RE.test(id)) throw new RequestError(404, 'VALIDATION_ERROR', '請求が見つかりません。', [{ path: '/id', code: 'not_found', message: 'idが不正です。' }]);
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

function parseBody<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({ path: `/${issue.path.map(String).join('/')}`, code: String(issue.code), message: zodIssueMessageJa(issue as unknown as ZodIssueLike) }));
    throw new RequestError(422, 'VALIDATION_ERROR', fields[0]?.message ?? '入力内容を確認してください。', fields);
  }
  return parsed.data as z.infer<S>;
}

function ctxOf(ctx: ApiContext): BillingContext {
  if (ctx.actor === null) throw new Error('actor required');
  return { actorId: ctx.actor.userId, roles: ctx.actor.roles, correlationId: ctx.correlationId, now: ctx.now };
}

function handler(operationId: OperationId, deps: BillingRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
  return createApiHandler(
    operationId,
    async (ctx) => {
      if (!featureFlags(deps.env?.() ?? process.env).billing) {
        // GAP-014: 404 の error code が辞書に無いため VALIDATION_ERROR（他の 404 と同じ扱い）
        return errorResponse(404, 'VALIDATION_ERROR', 'この機能は有効になっていません。', ctx.correlationId);
      }
      try {
        return await body(ctx);
      } catch (error) {
        if (error instanceof RequestError || error instanceof BillingError) {
          return errorResponse(error.status, error.code, error.message, ctx.correlationId, {
            ...(error.fields !== undefined ? { fields: error.fields } : {}),
            ...(error instanceof BillingError && error.extra !== undefined ? { extra: error.extra } : {}),
          });
        }
        throw error;
      }
    },
    deps.api,
  );
}

/** Idempotency-Key で冪等に実行する（作成・遷移） */
async function idempotent(deps: BillingRouteDeps, ctx: ApiContext, route: string, raw: unknown, status: number, run: () => Promise<unknown>): Promise<Response> {
  const actor = ctxOf(ctx);
  const repo = deps.idempotency();
  const begin = await beginIdempotentRequest(repo, { actorId: actor.actorId, route, key: ctx.idempotencyKey as string }, computeRequestHash('POST', route, raw), ctx.now);
  if (begin.kind === 'REPLAY') {
    return Response.json(begin.responseBody, { status: begin.responseStatus, headers: { 'x-correlation-id': ctx.correlationId, 'idempotent-replayed': 'true' } });
  }
  if (begin.kind !== 'PROCEED') {
    return errorResponse(409, 'IDEMPOTENCY_CONFLICT', begin.kind === 'IN_PROGRESS' ? '同じ操作を実行中です。' : '同じ Idempotency-Key で異なる内容が送信されました。', ctx.correlationId, { retryable: begin.kind === 'IN_PROGRESS' });
  }
  try {
    const data = await run();
    await repo.complete(begin.recordId, status, { data, meta: null });
    return dataResponse(status, data, ctx.correlationId);
  } catch (error) {
    await repo.fail(begin.recordId).catch(() => undefined);
    throw error;
  }
}

export function billingCollectionHandlers(deps: BillingRouteDeps) {
  return {
    GET: handler('listBillingRuns', deps, async (ctx) => {
      const q = rejectQuery(ctx.request, ['customerId', 'status']);
      const customerId = q.get('customerId');
      const status = q.get('status');
      if (customerId !== null && !UUID_RE.test(customerId)) throw new RequestError(400, 'VALIDATION_ERROR', 'customerId が不正です。', [{ path: '/query/customerId', code: 'format', message: 'uuid形式ではありません。' }]);
      if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new RequestError(400, 'VALIDATION_ERROR', 'status が不正です。', [{ path: '/query/status', code: 'enum', message: '未定義の状態です。' }]);
      const data = await deps.service().list({ customerId: customerId?.toLowerCase() ?? null, status: status as BillingRunStatus | null });
      return dataResponse(200, data, ctx.correlationId);
    }),
    POST: handler('createBillingRun', deps, async (ctx) => {
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const body = parseBody(createSchema, raw);
      return idempotent(deps, ctx, 'POST /billing-runs', raw, 201, () => deps.service().create({ customerId: body.customerId.toLowerCase(), periodEnd: body.periodEnd }, ctxOf(ctx)));
    }),
  };
}

export function billingItemHandlers(deps: BillingRouteDeps) {
  return {
    GET: handler('getBillingRun', deps, async (ctx) => {
      const id = runId(ctx.request);
      const q = rejectQuery(ctx.request, ['calcVersion']);
      const raw = q.get('calcVersion');
      const calcVersion = raw === null ? null : Number(raw);
      if (calcVersion !== null && (!Number.isInteger(calcVersion) || calcVersion < 1)) {
        throw new RequestError(400, 'VALIDATION_ERROR', 'calcVersion は 1 以上の整数です。', [{ path: '/query/calcVersion', code: 'range', message: '1 以上の整数です。' }]);
      }
      return dataResponse(200, await deps.service().get(id, calcVersion), ctx.correlationId);
    }),
  };
}

export function billingActionHandlers(deps: BillingRouteDeps) {
  return {
    POST: handler('transitionBillingRun', deps, async (ctx) => {
      const id = runId(ctx.request);
      const action = segmentsAfter(ctx.request)[1] ?? '';
      if (!(ACTIONS as readonly string[]).includes(action)) {
        throw new RequestError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: `${ACTIONS.join(' / ')} のみ利用できます。` }]);
      }
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const route = `POST /billing-runs/${id}/${action}`;
      const service = deps.service();
      const bc = ctxOf(ctx);
      switch (action as Action) {
        case 'review': {
          const cmd = parseBody(reviewSchema, raw);
          return idempotent(deps, ctx, route, raw, 200, () => service.review(id, cmd, bc));
        }
        case 'void': {
          const cmd = parseBody(commandSchema, raw);
          const reason = cmd.reason?.trim() ?? '';
          if (reason === '') throw new RequestError(422, 'VALIDATION_ERROR', '取消の理由を入力してください。', [{ path: '/reason', code: 'required', message: '取消の理由を入力してください。' }]);
          return idempotent(deps, ctx, route, raw, 200, () => service.void(id, { expectedVersion: cmd.expectedVersion, reason }, bc));
        }
        case 'calculate': {
          const cmd = parseBody(commandSchema, raw);
          return idempotent(deps, ctx, route, raw, 200, () => service.calculate(id, { expectedVersion: cmd.expectedVersion }, bc));
        }
        case 'finalize': {
          const cmd = parseBody(commandSchema, raw);
          return idempotent(deps, ctx, route, raw, 200, () => service.finalize(id, { expectedVersion: cmd.expectedVersion }, bc));
        }
      }
    }),
  };
}

// ---------------------------------------------------------------- CHG-011 請求書（API-022・023）

export function invoiceItemHandlers(deps: BillingRouteDeps) {
  return {
    GET: handler('getInvoice', deps, async (ctx) => {
      const id = idOf(ctx.request, 'invoices', '請求書');
      rejectQuery(ctx.request, []);
      return dataResponse(200, await deps.invoices().get(id, ctx.now), ctx.correlationId);
    }),
  };
}

export function invoiceActionHandlers(deps: BillingRouteDeps) {
  return {
    POST: handler('transitionInvoice', deps, async (ctx) => {
      const id = idOf(ctx.request, 'invoices', '請求書');
      const action = segmentsAfter(ctx.request, 'invoices')[1] ?? '';
      if (!(INVOICE_ACTIONS as readonly string[]).includes(action)) {
        throw new RequestError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: `${INVOICE_ACTIONS.join(' / ')} のみ利用できます。` }]);
      }
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const cmd = parseBody(commandSchema, raw);
      const status = action === 'void' ? 200 : 202;
      return idempotent(deps, ctx, `POST /invoices/${id}/${action}`, raw, status, () => deps.invoices().action(id, action as InvoiceAction, cmd, ctxOf(ctx)));
    }),
  };
}

// ---------------------------------------------------------------- CHG-011 遅延訂正の調整（API-035〜037）

export function adjustmentCollectionHandlers(deps: BillingRouteDeps) {
  return {
    GET: handler('listBillingAdjustments', deps, async (ctx) => {
      const q = rejectQuery(ctx.request, ['customerId', 'status']);
      const customerId = q.get('customerId');
      const status = q.get('status');
      if (customerId !== null && !UUID_RE.test(customerId)) throw new RequestError(400, 'VALIDATION_ERROR', 'customerId が不正です。', [{ path: '/query/customerId', code: 'format', message: 'uuid形式ではありません。' }]);
      if (status !== null && !(ADJUSTMENT_STATUSES as readonly string[]).includes(status)) throw new RequestError(400, 'VALIDATION_ERROR', 'status が不正です。', [{ path: '/query/status', code: 'enum', message: '未定義の状態です。' }]);
      const data = await deps.adjustments().list({ customerId: customerId?.toLowerCase() ?? null, status: status as AdjustmentStatus | null });
      return dataResponse(200, data, ctx.correlationId);
    }),
    POST: handler('createBillingAdjustment', deps, async (ctx) => {
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const body = parseBody(adjustmentCreateSchema, raw);
      return idempotent(deps, ctx, 'POST /billing-adjustments', raw, 201, () =>
        deps.adjustments().create(
          {
            sourceInvoiceId: body.sourceInvoiceId.toLowerCase(),
            productId: body.productId.toLowerCase(),
            sourceReportId: body.sourceReportId === undefined || body.sourceReportId === null ? null : body.sourceReportId.toLowerCase(),
            description: body.description,
            amountYen: body.amountYen,
            reason: body.reason,
          },
          ctxOf(ctx),
        ),
      );
    }),
  };
}

export function adjustmentActionHandlers(deps: BillingRouteDeps) {
  return {
    POST: handler('cancelBillingAdjustment', deps, async (ctx) => {
      const id = idOf(ctx.request, 'billing-adjustments', '調整');
      const action = segmentsAfter(ctx.request, 'billing-adjustments')[1] ?? '';
      if (action !== 'cancel') throw new RequestError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: 'cancel のみ利用できます。' }]);
      rejectQuery(ctx.request, []);
      const raw = await readJson(ctx.request);
      const cmd = parseBody(commandSchema, raw);
      return idempotent(deps, ctx, `POST /billing-adjustments/${id}/cancel`, raw, 200, () => deps.adjustments().cancel(id, { expectedVersion: cmd.expectedVersion, reason: cmd.reason?.trim() ?? '' }, ctxOf(ctx)));
    }),
  };
}
