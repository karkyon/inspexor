import { inventoryPreviewHandlers } from '../../../../../lib/inventory/inventory-handlers';
import { inventoryRouteDeps } from '../../../../../lib/inventory/inventory-route-deps';

export const dynamic = 'force-dynamic';

const handlers = inventoryPreviewHandlers(inventoryRouteDeps);

// API-053 getInventoryPreview（CHG-018）: 日報の入力画面（STEP4）用の在庫残高。現場も参照できる
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
