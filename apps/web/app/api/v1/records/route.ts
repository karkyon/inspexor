import { recordListHandlers } from '../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../lib/field/field-route-deps';

const handlers = recordListHandlers(fieldRouteDeps);

// API-012 listRecords（FIELD は自分の分のみ: CHG-002）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
