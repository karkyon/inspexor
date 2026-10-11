import { recordListHandlers } from '../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../lib/field/field-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = recordListHandlers(fieldRouteDeps);

// API-012 listRecords（FIELD は自分の分のみ: CHG-002）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
