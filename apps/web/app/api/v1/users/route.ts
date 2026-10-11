import { userCollectionHandlers } from '../../../../lib/users/user-handlers';
import { userRouteDeps } from '../../../../lib/users/user-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = userCollectionHandlers(userRouteDeps);

// API-030 listUsers / API-031 createUser（CHG-008）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
