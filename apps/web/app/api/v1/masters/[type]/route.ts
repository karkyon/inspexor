import { masterCollectionHandlers } from '../../../../../lib/masters/master-handlers';
import { masterRouteDeps } from '../../../../../lib/masters/master-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = masterCollectionHandlers(masterRouteDeps);

// API-014 listMasters / API-015 createMaster
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
