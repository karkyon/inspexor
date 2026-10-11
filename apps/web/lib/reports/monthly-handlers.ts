/**
 * API-027 GET /reports/monthly（月次集計 JSON）/ API-028 GET /reports/monthly/export（Excel・CSV）。CHG-004 D4。
 * 入口ガード（認証→認可）は createApiHandler。query は既知のものだけ受け付ける（未知は 400）。
 */
import { isMonth } from '@inspexor/domain';
import type { DocStore } from '@inspexor/docstore';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { EXPORT_SHEETS, MonthlyService, type ExportSheet, type MonthlyQuery } from './monthly-service';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface MonthlyRouteDeps {
  readonly store: () => DocStore;
  readonly api: () => ApiHandlerDeps;
}

class QueryError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

function parse(request: Request, extra: readonly string[]): { q: MonthlyQuery; params: URLSearchParams } {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!['month', 'type', 'customerId', 'productId', ...extra].includes(key)) throw new QueryError(`/query/${key}`, `未知のquery parameterです: ${key}`);
  }
  const month = params.get('month') ?? '';
  if (!isMonth(month)) throw new QueryError('/query/month', '対象年月は YYYY-MM で指定してください。');
  const type = params.get('type');
  if (type !== null && type !== 'WORK' && type !== 'DELIVERY') throw new QueryError('/query/type', 'type は WORK / DELIVERY のいずれかです。');
  const uuid = (key: string): string | null => {
    const v = params.get(key);
    if (v === null) return null;
    if (!UUID_RE.test(v)) throw new QueryError(`/query/${key}`, `${key} が不正です。`);
    return v.toLowerCase();
  };
  return { q: { month, type: type as MonthlyQuery['type'], customerId: uuid('customerId'), productId: uuid('productId') }, params };
}

function guard(ctx: ApiContext, fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((error: unknown) => {
    if (error instanceof QueryError) {
      return errorResponse(400, 'VALIDATION_ERROR', error.message, ctx.correlationId, { fields: [{ path: error.path, code: 'invalid', message: error.message }] });
    }
    throw error;
  });
}

export function monthlyHandlers(deps: MonthlyRouteDeps) {
  return {
    GET: createApiHandler(
      'getMonthlySummary',
      (ctx) =>
        guard(ctx, async () => {
          const { q } = parse(ctx.request, []);
          return dataResponse(200, await new MonthlyService(deps.store()).summary(q), ctx.correlationId);
        }),
      deps.api,
    ),
  };
}

export function monthlyExportHandlers(deps: MonthlyRouteDeps) {
  return {
    GET: createApiHandler(
      'exportMonthlySummary',
      (ctx) =>
        guard(ctx, async () => {
          const { q, params } = parse(ctx.request, ['format', 'sheet']);
          const format = params.get('format') ?? 'xlsx';
          if (format !== 'xlsx' && format !== 'csv') throw new QueryError('/query/format', 'format は xlsx / csv のいずれかです。');
          const sheet = params.get('sheet') ?? 'detail';
          if (!(EXPORT_SHEETS as readonly string[]).includes(sheet)) throw new QueryError('/query/sheet', `sheet は ${EXPORT_SHEETS.join(' / ')} のいずれかです。`);
          const file = await new MonthlyService(deps.store()).export(q, format, sheet as ExportSheet);
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
      deps.api,
    ),
  };
}
