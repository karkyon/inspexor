import { invoiceActionHandlers } from '../../../../../../lib/billing/billing-handlers';
import { billingRouteDeps } from '../../../../../../lib/billing/billing-route-deps';
import { withWorkerKick } from '../../../../../../lib/worker/kick';

export const dynamic = 'force-dynamic';

const handlers = invoiceActionHandlers(billingRouteDeps);

// API-023 transitionInvoice（CHG-011: issue / send / resend / void）。発行・送付の直後に worker を起こす
export async function POST(request: Request): Promise<Response> {
  return withWorkerKick(await handlers.POST(request));
}
