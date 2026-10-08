import { fieldItemHandlers } from '../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../lib/field/field-route-deps';

const handlers = fieldItemHandlers('WORK', fieldRouteDeps);

// API-005 getWorkReport
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

// API-006 updateWorkReport
export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}
