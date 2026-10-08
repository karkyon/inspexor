import { masterItemHandlers } from '../../../../../../lib/masters/master-handlers';
import { masterRouteDeps } from '../../../../../../lib/masters/master-route-deps';

const handlers = masterItemHandlers(masterRouteDeps);

// API-016 getMaster / API-017 updateMaster / API-018 deactivateMaster
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handlers.PATCH(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handlers.DELETE(request);
}
