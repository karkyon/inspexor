import { fieldItemHandlers } from '../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../lib/field/field-route-deps';

const handlers = fieldItemHandlers('DELIVERY', fieldRouteDeps);

// API-009 getDeliveryReport
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

// API-010 updateDeliveryReport
export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}
