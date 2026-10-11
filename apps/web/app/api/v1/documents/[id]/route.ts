import { documentItemHandlers } from '../../../../../lib/documents/document-handlers';
import { documentRouteDeps } from '../../../../../lib/documents/document-route-deps';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const handlers = documentItemHandlers(documentRouteDeps);

// API-024 getDocument（メタデータ＋10分の署名付き URL）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
