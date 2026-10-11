import { fieldConfirmHandlers } from '../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../lib/field/field-route-deps';
import { withWorkerKick } from '../../../../../../lib/worker/kick';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = fieldConfirmHandlers('WORK', fieldRouteDeps);

// API-007 confirmWorkReport（Idempotency-Key 必須）
export async function POST(request: Request): Promise<Response> {
  // CHG-006: 成功したら worker（Cloud Run）を起こす（WORKER_URL 未設定の開発環境では何もしない）
  return withWorkerKick(await handlers.POST(request));
}
