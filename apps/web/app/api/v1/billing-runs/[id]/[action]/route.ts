import { billingActionHandlers } from '../../../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../../../lib/billing/billing-route-deps';

export const dynamic = 'force-dynamic';

const handlers = billingActionHandlers(billingRouteDeps);

// API-021 transitionBillingRun（calculate / review / finalize / void、CHG-009 SCR-14）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
