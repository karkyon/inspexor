/**
 * 在庫管理の API（CHG-018、SK-2026-08-MINI-09 13.2）。INVENTORY_ENABLED が無効なら 404（画面・API・日報の在庫の欄は出ない）。
 *  API-047 GET /inventory                                       残高（asOf）
 *  API-048 GET /inventory/{productId}/movements                  取引の一覧
 *  API-049 POST /inventory/{productId}/{action}                  delivery / replenish / stocktake / opening（preview=true で保存しない）
 *  API-050 GET /inventory/monthly/export                         在庫集計表（Excel）
 *  API-051 GET /inventory/{productId}/monthly                    在庫集計表（画面）
 *  API-052 POST /inventory/{productId}/movements/{movementId}/reverse  取消し（理由必須）
 *  API-053 GET /work-reports/inventory-preview                   日報の入力画面用の残高（現場も参照可。productId 必須）
 */
import { featureFlags, isMonth, type CountBy, type OperationId } from '@inspexor/domain';
import type { IdempotencyRepository } from '@inspexor/application';
import { z, type ZodTypeAny } from 'zod';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { zodIssueMessageJa, type ZodIssueLike } from '../http/zod-messages';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';
import { InventoryError, InventoryService, REGISTER_ACTIONS, isBusinessDate, mapDomainError, type InventoryContext, type RegisterAction } from './inventory-service';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface InventoryRouteDeps {
  readonly service: () => InventoryService;
  readonly idempotency: () => IdempotencyRepository;
  readonly api: () => ApiHandlerDeps;
  readonly env?: () => Readonly<Record<string, string | undefined>>;
}

const dateStr = z.string().refine(isBusinessDate, 'YYYY-MM-DD形式の日付ではありません');
const registerSchema = z
  .object({
    businessDate: dateStr,
    preview: z.boolean().optional(),
    acknowledgeAdjustShort: z.boolean().optional(),
    reason: z.string().trim().max(1000).optional(),
    quantity: z.number().int().min(1).max(9_999_999).optional(),
    lotKey: z.string().min(1).max(300).optional(),
    boxes: z.number().int().min(1).max(99_999).optional(),
    countedDeposit: z.number().int().min(0).max(99_999_999).optional(),
    countedAdjust: z.number().int().min(0).max(99_999_999).optional(),
    adjust: z.number().int().min(0).max(99_999_999).optional(),
    lots: z.array(z.object({ lotDate: dateStr, lotLabel: z.string().trim().max(100).optional(), quantity: z.number().int().min(1).max(99_999_999) }).strict()).max(200).optional(),
  })
  .strict();
const reverseSchema = z.object({ reason: z.string().trim().min(1, '取消しの理由を入力してください。').max(1000) }).strict();

function segmentsAfterInventory(request: Request): string[] {
  const segs = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  return segs.slice(segs.indexOf('inventory') + 1);
}

function productIdOf(request: Request): string {
  const id = segmentsAfterInventory(request)[0] ?? '';
  if (!UUID_RE.test(id)) throw new InventoryError(404, 'VALIDATION_ERROR', '品番が見つかりません。', [{ path: '/productId', code: 'not_found', message: 'productId が不正です。' }]);
  return id.toLowerCase();
}

function query(request: Request, allowed: readonly string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!allowed.includes(key)) throw new InventoryError(400, 'VALIDATION_ERROR', `未知のquery parameterです: ${key}`, [{ path: `/query/${key}`, code: 'unknown', message: '未知のparameterです。' }]);
  return params;
}

function dateQuery(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  if (v === null || v === '') return null;
  if (!isBusinessDate(v)) throw new InventoryError(400, 'VALIDATION_ERROR', `${key} は YYYY-MM-DD で指定してください。`, [{ path: `/query/${key}`, code: 'format', message: '日付の形式が不正です。' }]);
  return v;
}

function countByOf(params: URLSearchParams): CountBy {
  const v = params.get('countBy') ?? 'INSPECTION_MONTH';
  if (v !== 'INSPECTION_MONTH' && v !== 'DELIVERY_MONTH') throw new InventoryError(400, 'VALIDATION_ERROR', 'countBy は INSPECTION_MONTH / DELIVERY_MONTH のいずれかです。', [{ path: '/query/countBy', code: 'enum', message: '未定義の値です。' }]);
  return v;
}

function monthOf(params: URLSearchParams): string {
  const m = params.get('month') ?? '';
  if (!isMonth(m)) throw new InventoryError(400, 'VALIDATION_ERROR', '対象年月は YYYY-MM で指定してください。', [{ path: '/query/month', code: 'format', message: '対象年月は YYYY-MM で指定してください。' }]);
  return m;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InventoryError(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。');
  }
}

function parseBody<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({ path: `/${issue.path.map(String).join('/')}`, code: String(issue.code), message: zodIssueMessageJa(issue as unknown as ZodIssueLike) }));
    throw new InventoryError(422, 'VALIDATION_ERROR', fields[0]?.message ?? '入力内容を確認してください。', fields);
  }
  return parsed.data as z.infer<S>;
}

function ctxOf(ctx: ApiContext): InventoryContext {
  if (ctx.actor === null) throw new Error('actor required');
  return { actorId: ctx.actor.userId, roles: ctx.actor.roles, correlationId: ctx.correlationId, now: ctx.now };
}

function handler(operationId: OperationId, deps: InventoryRouteDeps, body: (ctx: ApiContext) => Promise<Response>) {
  return createApiHandler(
    operationId,
    async (ctx) => {
      if (!featureFlags(deps.env?.() ?? process.env).inventory) {
        // 404 の error code が辞書に無いため VALIDATION_ERROR（他の機能の無効時と同じ扱い）
        return errorResponse(404, 'VALIDATION_ERROR', 'この機能は有効になっていません。', ctx.correlationId);
      }
      try {
        return await body(ctx);
      } catch (raw) {
        const error = mapDomainError(raw);
        if (error instanceof InventoryError) {
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

/** Idempotency-Key で冪等に実行する（登録・取消し）。preview は保存しないため冪等の対象外 */
async function idempotent(deps: InventoryRouteDeps, ctx: ApiContext, route: string, raw: unknown, status: number, run: () => Promise<unknown>): Promise<Response> {
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

export function inventoryListHandlers(deps: InventoryRouteDeps) {
  return {
    GET: handler('listInventory', deps, async (ctx) => {
      const q = query(ctx.request, ['asOf']);
      return dataResponse(200, await deps.service().list(dateQuery(q, 'asOf')), ctx.correlationId);
    }),
  };
}

export function inventoryMovementsHandlers(deps: InventoryRouteDeps) {
  return {
    GET: handler('listInventoryMovements', deps, async (ctx) => {
      const productId = productIdOf(ctx.request);
      const q = query(ctx.request, ['from', 'to', 'type', 'includeReversed']);
      const type = q.get('type');
      return dataResponse(
        200,
        await deps.service().movements(productId, { from: dateQuery(q, 'from'), to: dateQuery(q, 'to'), type: type === '' ? null : type, includeReversed: q.get('includeReversed') === 'true' }),
        ctx.correlationId,
      );
    }),
  };
}

export function inventoryActionHandlers(deps: InventoryRouteDeps) {
  return {
    POST: handler('registerInventory', deps, async (ctx) => {
      const productId = productIdOf(ctx.request);
      const action = segmentsAfterInventory(ctx.request)[1] ?? '';
      if (!(REGISTER_ACTIONS as readonly string[]).includes(action)) throw new InventoryError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: `${REGISTER_ACTIONS.join(' / ')} のいずれかです。` }]);
      query(ctx.request, []);
      const raw = await readJson(ctx.request);
      const body = parseBody(registerSchema, raw);
      const input = { ...body, ...(body.lots ? { lots: body.lots.map((l) => ({ lotDate: l.lotDate, quantity: l.quantity, ...(l.lotLabel ? { lotLabel: l.lotLabel } : {}) })) } : {}) };
      const run = (): Promise<Record<string, unknown>> => deps.service().register(productId, action as RegisterAction, input, ctxOf(ctx));
      // preview は保存しない（冪等の記録を作らない）
      if (body.preview === true) return dataResponse(200, await run(), ctx.correlationId);
      return idempotent(deps, ctx, `POST /inventory/${productId}/${action}`, raw, 201, run);
    }),
  };
}

export function inventoryMonthlyHandlers(deps: InventoryRouteDeps) {
  return {
    GET: handler('getInventoryMonthly', deps, async (ctx) => {
      const productId = productIdOf(ctx.request);
      const q = query(ctx.request, ['month', 'countBy']);
      return dataResponse(200, await deps.service().monthly(productId, monthOf(q), countByOf(q)), ctx.correlationId);
    }),
  };
}

export function inventoryExportHandlers(deps: InventoryRouteDeps) {
  return {
    GET: handler('exportInventoryMonthly', deps, async (ctx) => {
      const q = query(ctx.request, ['month', 'countBy', 'productId']);
      const pid = q.get('productId');
      if (pid !== null && !UUID_RE.test(pid)) throw new InventoryError(400, 'VALIDATION_ERROR', 'productId が不正です。', [{ path: '/query/productId', code: 'format', message: 'uuid形式ではありません。' }]);
      const file = await deps.service().export(monthOf(q), countByOf(q), pid === null ? null : pid.toLowerCase());
      const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_');
      return new Response(new Uint8Array(file.body), {
        status: 200,
        headers: {
          'content-type': file.contentType,
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'x-correlation-id': ctx.correlationId,
        },
      });
    }),
  };
}

export function inventoryReverseHandlers(deps: InventoryRouteDeps) {
  return {
    POST: handler('reverseInventoryMovement', deps, async (ctx) => {
      const segs = segmentsAfterInventory(ctx.request);
      const productId = productIdOf(ctx.request);
      const movementId = segs[2] ?? '';
      if (!UUID_RE.test(movementId)) throw new InventoryError(404, 'VALIDATION_ERROR', '取引が見つかりません。', [{ path: '/movementId', code: 'not_found', message: 'movementId が不正です。' }]);
      query(ctx.request, []);
      const raw = await readJson(ctx.request);
      const body = parseBody(reverseSchema, raw);
      return idempotent(deps, ctx, `POST /inventory/${productId}/movements/${movementId.toLowerCase()}/reverse`, raw, 200, () => deps.service().reverse(productId, movementId.toLowerCase(), body.reason, ctxOf(ctx)));
    }),
  };
}

export function inventoryPreviewHandlers(deps: InventoryRouteDeps) {
  return {
    GET: handler('getInventoryPreview', deps, async (ctx) => {
      const q = query(ctx.request, ['productId', 'asOf']);
      const id = q.get('productId') ?? '';
      if (!UUID_RE.test(id)) throw new InventoryError(400, 'VALIDATION_ERROR', 'productId を指定してください。', [{ path: '/query/productId', code: 'format', message: 'productId が不正です。' }]);
      return dataResponse(200, await deps.service().one(id.toLowerCase(), dateQuery(q, 'asOf')), ctx.correlationId);
    }),
  };
}
