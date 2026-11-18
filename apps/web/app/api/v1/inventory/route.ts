import { inventoryListHandlers } from '../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryListHandlers(inventoryRouteDeps);

// API-047 listInventory（CHG-018）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
