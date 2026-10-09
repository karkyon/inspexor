import { getDocStore } from '../../../lib/db/docstore';

// 稼働確認（業務ロジックなし）。CHG-006: Firestore へ実際に1件読込を行い接続を確認する（文書が無くても成功）。
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  try {
    await getDocStore().get('_health/ping');
    return Response.json({ app: 'ok', db: 'ok', latencyMs: Date.now() - startedAt }, { status: 200 });
  } catch (err) {
    // 内部詳細は返さない（ログのみ）
    console.error('[health] firestore', err instanceof Error ? err.message : String(err));
    return Response.json({ app: 'ok', db: 'ng' }, { status: 500 });
  }
}
