import { monthlyExportHandlers } from '../../../../../../lib/reports/monthly-handlers';
import { monthlyRouteDeps } from '../../../../../../lib/reports/monthly-route-deps';

const handlers = monthlyExportHandlers(monthlyRouteDeps);

// API-028 exportMonthlySummary（CHG-004 D4: Excel / CSV）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
