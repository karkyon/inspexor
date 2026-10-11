import { masterItemHandlers } from '../../../../../../lib/masters/master-handlers';
import { masterRouteDeps } from '../../../../../../lib/masters/master-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = masterItemHandlers(masterRouteDeps);

// API-016 getMaster / API-017 updateMaster / API-018 deactivateMaster
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handlers.DELETE(request);
}
