import { inventoryActionHandlers } from '../../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryActionHandlers(inventoryRouteDeps);

// API-049 registerInventory（delivery / replenish / stocktake / opening）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
