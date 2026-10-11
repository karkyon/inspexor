import { recordTransitionHandlers } from '../../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../../lib/field/field-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = recordTransitionHandlers(fieldRouteDeps);

// API-013 transitionRecord（CHG-004: revise のみ。承認系は対象外）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
