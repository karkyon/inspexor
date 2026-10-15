import { invoiceItemHandlers } from '../../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../../lib/billing/billing-route-deps';

export const dynamic = 'force-dynamic';

const handlers = invoiceItemHandlers(billingRouteDeps);

// API-022 getInvoice（CHG-011 SCR-15）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
