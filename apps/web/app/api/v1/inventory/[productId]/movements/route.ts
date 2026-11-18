import { inventoryMovementsHandlers } from '../../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryMovementsHandlers(inventoryRouteDeps);

// API-048 listInventoryMovements
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
