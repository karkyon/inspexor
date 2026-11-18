import { inventoryExportHandlers } from '../../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryExportHandlers(inventoryRouteDeps);

// API-050 exportInventoryMonthly（Excel）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
