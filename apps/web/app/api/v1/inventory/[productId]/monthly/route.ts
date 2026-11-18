import { inventoryMonthlyHandlers } from '../../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryMonthlyHandlers(inventoryRouteDeps);

// API-051 getInventoryMonthly
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
