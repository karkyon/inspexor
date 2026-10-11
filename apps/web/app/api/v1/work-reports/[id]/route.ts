import { fieldItemHandlers } from '../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../lib/field/field-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = fieldItemHandlers('WORK', fieldRouteDeps);

// API-005 getWorkReport
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

// API-006 updateWorkReport
export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}
