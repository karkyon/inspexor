import { handleMeRequest } from '../../../../lib/auth/me-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleMeRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
