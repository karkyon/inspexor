import { adjustmentCollectionHandlers } from '../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../lib/billing/billing-route-deps';

export const dynamic = 'force-dynamic';

const handlers = adjustmentCollectionHandlers(billingRouteDeps);

// API-035 listBillingAdjustments（CHG-011 遅延訂正）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

// API-036 createBillingAdjustment
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
