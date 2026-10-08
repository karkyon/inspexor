import { fieldCollectionHandlers } from '../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../lib/field/field-route-deps';

const handlers = fieldCollectionHandlers('WORK', fieldRouteDeps);

// API-004 createWorkReport
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
