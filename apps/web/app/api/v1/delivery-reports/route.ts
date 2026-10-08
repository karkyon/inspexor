import { fieldCollectionHandlers } from '../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../lib/field/field-route-deps';

const handlers = fieldCollectionHandlers('DELIVERY', fieldRouteDeps);

// API-008 createDeliveryReport
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
