/**
 * 帳票ファイルの配信口（API-024 が発行する10分の署名付き URL の宛先。/api/health と同じく契約外の基盤 route）。
 * CHG-006: 保存先は Cloud Storage（STORAGE_BUCKET）または開発用ローカルディスク。どちらも署名の検証後に web が読み出して返す
 * （バケットは非公開のまま。利用者に Cloud Storage の URL は渡さない）。
 * `disposition=inline` を付けるとブラウザ内で表示（提案書: 日報PDFのプレビュー）。署名の対象外（表示方法のみ）。
 */
import { filePath, storageFromEnv, StorageError, type FileDoc } from '@inspexor/docstore';
import { getDocStore } from '../../../../lib/db/docstore';
import { getSessionSecret } from '../../../../lib/auth/session-secret';
import { verifyFileSignature } from '../../../../lib/documents/signed-url';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const url = new URL(request.url);
  if (!UUID_RE.test(params.id)) return deny(404);
  if (!verifyFileSignature(params.id, url.searchParams.get('exp'), url.searchParams.get('sig'), new Date(), getSessionSecret())) return deny(403);
  const file = await getDocStore().get<FileDoc>(filePath(params.id));
  if (file === null) return deny(404);
  let bytes: Buffer;
  try {
    bytes = (await storageFromEnv().get(file.storageKey)).bytes;
  } catch (error) {
    if (error instanceof StorageError && error.code === 'NOT_FOUND') return deny(404);
    console.error('[files] storage', error instanceof Error ? error.message : String(error));
    return deny(503);
  }
  const name = file.storageKey.split('/').pop() ?? 'document.pdf';
  const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-disposition': `${disposition}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
