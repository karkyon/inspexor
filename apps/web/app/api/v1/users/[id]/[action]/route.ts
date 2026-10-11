import { userActionHandlers } from '../../../../../../lib/users/user-handlers';
import { userRouteDeps } from '../../../../../../lib/users/user-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = userActionHandlers(userRouteDeps);

// API-033 userAction（CHG-008: deactivate / activate / reset-password / unlock）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
