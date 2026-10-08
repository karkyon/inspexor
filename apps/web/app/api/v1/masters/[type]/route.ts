import { masterCollectionHandlers } from '../../../../../lib/masters/master-handlers';
import { masterRouteDeps } from '../../../../../lib/masters/master-route-deps';

const handlers = masterCollectionHandlers(masterRouteDeps);

// API-014 listMasters / API-015 createMaster
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
