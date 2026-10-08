/**
 * 開発用 storage adapter の配信口（API-024 が発行する10分の署名付き URL の宛先。/api/health と同じく契約外の基盤 route）。
 * 本番（STORAGE_BUCKET 設定時）は Cloud Storage の署名 URL を使うため、この route は 404 を返す（G9）。
 */
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { getPool } from '../../../../lib/db/pg';
import { getSessionSecret } from '../../../../lib/auth/session-secret';
import { storageDir, verifyFileSignature } from '../../../../lib/documents/signed-url';

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (process.env['STORAGE_BUCKET']) return deny(404);
  const url = new URL(request.url);
  if (!UUID_RE.test(params.id)) return deny(404);
  if (!verifyFileSignature(params.id, url.searchParams.get('exp'), url.searchParams.get('sig'), new Date(), getSessionSecret())) return deny(403);
  const r = await getPool().query<{ storage_key: string; mime_type: string; sha256: string }>('SELECT storage_key, mime_type, sha256 FROM app.files WHERE id = $1', [params.id]);
  const file = r.rows[0];
  if (file === undefined) return deny(404);
  const root = resolve(storageDir());
  const path = resolve(join(root, file.storage_key));
  if (!path.startsWith(root + sep)) return deny(404);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return deny(404);
  }
  const name = file.storage_key.split('/').pop() ?? 'document.pdf';
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': file.mime_type,
      'content-disposition': `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
