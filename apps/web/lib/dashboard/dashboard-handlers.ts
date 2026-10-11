/** CHG-007 API-029 GET /dashboard（SCR-10）。APPROVAL_ENABLED のときだけ（無効時は 404: 提案書の対象外「高機能ダッシュボード」は Blind） */
import { featureFlags } from '@inspexor/domain';
import type { DocStore } from '@inspexor/docstore';
import { createApiHandler, type ApiHandlerDeps } from '../http/api-handler';
import { dataResponse, errorResponse } from '../http/api-response';
import { DashboardService } from './dashboard-service';

export interface DashboardRouteDeps {
  readonly store: () => DocStore;
  readonly api: () => ApiHandlerDeps;
  readonly env?: () => Readonly<Record<string, string | undefined>>;
}

export function dashboardHandlers(deps: DashboardRouteDeps) {
  return {
    GET: createApiHandler(
      'getDashboard',
      async (ctx) => {
        if (!featureFlags(deps.env?.() ?? process.env).approval) {
          // GAP-014: 404 の error code が辞書に無いため VALIDATION_ERROR（他の 404 と同じ扱い）
          return errorResponse(404, 'VALIDATION_ERROR', 'この機能は有効になっていません。', ctx.correlationId);
        }
        if ([...new URL(ctx.request.url).searchParams.keys()].length > 0) {
          return errorResponse(400, 'VALIDATION_ERROR', 'query parameter は指定できません。', ctx.correlationId);
        }
        return dataResponse(200, await new DashboardService(deps.store()).get(ctx.now), ctx.correlationId);
      },
      deps.api,
    ),
  };
}
