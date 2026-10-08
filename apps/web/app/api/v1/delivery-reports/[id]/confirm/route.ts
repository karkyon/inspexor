import { fieldConfirmHandlers } from '../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../lib/field/field-route-deps';

const handlers = fieldConfirmHandlers('DELIVERY', fieldRouteDeps);

// API-011 confirmDeliveryReport（Idempotency-Key 必須）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
