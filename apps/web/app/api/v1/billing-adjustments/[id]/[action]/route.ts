import { adjustmentActionHandlers } from '../../../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../../../lib/billing/billing-route-deps';

export const dynamic = 'force-dynamic';

const handlers = adjustmentActionHandlers(billingRouteDeps);

// API-037 cancelBillingAdjustment（CHG-011: cancel）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
