import { dashboardHandlers } from '../../../../lib/dashboard/dashboard-handlers';
import { dashboardRouteDeps } from '../../../../lib/dashboard/dashboard-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = dashboardHandlers(dashboardRouteDeps);

// API-029 getDashboard（CHG-007 SCR-10）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
