import { billingCollectionHandlers } from '../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../lib/billing/billing-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = billingCollectionHandlers(billingRouteDeps);

// API-034 listBillingRuns（CHG-009 SCR-14）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

// API-019 createBillingRun
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
