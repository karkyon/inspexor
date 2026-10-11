import { monthlyExportHandlers } from '../../../../../../lib/reports/monthly-handlers';
import { monthlyRouteDeps } from '../../../../../../lib/reports/monthly-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = monthlyExportHandlers(monthlyRouteDeps);

// API-028 exportMonthlySummary（CHG-004 D4: Excel / CSV）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
