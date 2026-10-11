import { userItemHandlers } from '../../../../../lib/users/user-handlers';
import { userRouteDeps } from '../../../../../lib/users/user-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = userItemHandlers(userRouteDeps);

// API-032 updateUser（CHG-008）
export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}
