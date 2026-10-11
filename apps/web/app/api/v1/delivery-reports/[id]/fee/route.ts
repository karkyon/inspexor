import { deliveryFeeHandlers } from '../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../lib/field/field-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = deliveryFeeHandlers(fieldRouteDeps);

// API-026 setDeliveryFee（CHG-004 D2: 運搬費の後入力・修正）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
