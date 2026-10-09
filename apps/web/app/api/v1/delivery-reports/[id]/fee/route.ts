import { deliveryFeeHandlers } from '../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../lib/field/field-route-deps';

const handlers = deliveryFeeHandlers(fieldRouteDeps);

// API-026 setDeliveryFee（CHG-004 D2: 運搬費の後入力・修正）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
