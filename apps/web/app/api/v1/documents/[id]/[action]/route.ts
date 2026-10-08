import { documentActionHandlers } from '../../../../../../lib/documents/document-handlers';
import { documentRouteDeps } from '../../../../../../lib/documents/document-route-deps';

const handlers = documentActionHandlers(documentRouteDeps);

// API-025 documentAction（regenerate / send / retry、Idempotency-Key 必須、理由必須）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
