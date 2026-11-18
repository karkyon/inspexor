import { inventoryReverseHandlers } from '../../../../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryReverseHandlers(inventoryRouteDeps);

// API-052 reverseInventoryMovement
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
