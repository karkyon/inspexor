import { billingItemHandlers } from '../../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../../lib/billing/billing-route-deps';

export const dynamic = 'force-dynamic';

const handlers = billingItemHandlers(billingRouteDeps);

// API-020 getBillingRun（CHG-009 SCR-14）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
