import { monthlyHandlers } from '../../../../../lib/reports/monthly-handlers';
import { monthlyRouteDeps } from '../../../../../lib/reports/monthly-route-deps';

const handlers = monthlyHandlers(monthlyRouteDeps);

// API-027 getMonthlySummary（CHG-004 D4: 月次集計）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
