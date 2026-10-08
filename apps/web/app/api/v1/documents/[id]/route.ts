import { documentItemHandlers } from '../../../../../lib/documents/document-handlers';
import { documentRouteDeps } from '../../../../../lib/documents/document-route-deps';

const handlers = documentItemHandlers(documentRouteDeps);

// API-024 getDocument（メタデータ＋10分の署名付き URL）
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}
