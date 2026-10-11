/**
 * GcsStorage の読出し（fetch で JSON API を直接呼ぶ。g25a）と LocalFsStorage.stat の単体試験。
 * Cloud Storage の代わりに、手元の HTTP サーバーで応答（正常・404・503・応答停止）を再現する。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GcsStorage, LocalFsStorage, md5Base64, StorageError } from './storage';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handlers: Handler[] = [];
let seen: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    const h = handlers.shift();
    if (h) h(req, res);
    else {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  handlers = [];
  seen = [];
});

const gcs = (o: { timeout?: number } = {}) =>
  new GcsStorage('ix-bucket', { apiBase: base, authHeaders: async () => ({ authorization: 'Bearer test-token' }), requestTimeoutMs: o.timeout ?? 2_000 });
const pdf = Buffer.from('%PDF-1.7 試験 %%EOF');
const ok: Handler = (_q, s) => {
  s.setHeader('content-type', 'application/pdf');
  s.end(pdf);
};

describe('GcsStorage（JSON API を fetch で直接呼ぶ）', () => {
  it('get: alt=media で本文を返す。key は1つの path 要素として符号化し、認証ヘッダを付ける', async () => {
    handlers.push(ok);
    const got = await gcs().get('documents/DAILY/WR-202610-0001/job/作業結果報告書.pdf');
    expect(got.bytes.equals(pdf)).toBe(true);
    expect(seen[0]?.url).toBe(`/storage/v1/b/ix-bucket/o/${encodeURIComponent('documents/DAILY/WR-202610-0001/job/作業結果報告書.pdf')}?alt=media`);
    expect(seen[0]?.auth).toBe('Bearer test-token');
  });

  it('get: 404 は NOT_FOUND（再試行しない）', async () => {
    handlers.push((_q, s) => {
      s.statusCode = 404;
      s.end('{}');
    });
    await expect(gcs().get('a/b.pdf')).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(seen).toHaveLength(1);
  });

  it('get: 503 は再試行して成功する', async () => {
    handlers.push((_q, s) => {
      s.statusCode = 503;
      s.end();
    }, ok);
    expect((await gcs().get('a/b.pdf')).bytes.equals(pdf)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('get: 応答が止まったら打ち切って再試行する（g24b の遅延の再現）', async () => {
    handlers.push(() => undefined /* 応答しない */, ok);
    const t = Date.now();
    expect((await gcs({ timeout: 300 }).get('a/b.pdf')).bytes.equals(pdf)).toBe(true);
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(seen).toHaveLength(2);
  });

  it('get: 3回とも失敗したら DEPENDENCY_UNAVAILABLE（retry 対象）', async () => {
    for (let i = 0; i < 3; i += 1) handlers.push(() => undefined);
    const err = await gcs({ timeout: 200 }).get('a/b.pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });
    expect(seen).toHaveLength(3);
  });

  it('get: 403 は再試行しない（retryable=false）', async () => {
    handlers.push((_q, s) => {
      s.statusCode = 403;
      s.end();
    });
    await expect(gcs().get('a/b.pdf')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: false });
    expect(seen).toHaveLength(1);
  });

  it('stat: size と md5Hash を返す（本文は読まない）', async () => {
    handlers.push((_q, s) => {
      s.setHeader('content-type', 'application/json');
      s.end(JSON.stringify({ size: String(pdf.byteLength), md5Hash: md5Base64(pdf) }));
    });
    expect(await gcs().stat('a/b.pdf')).toEqual({ sizeBytes: pdf.byteLength, md5Base64: md5Base64(pdf) });
    expect(seen[0]?.url).toBe('/storage/v1/b/ix-bucket/o/a%2Fb.pdf?fields=size%2Cmd5Hash');
  });

  it('stat: md5Hash が無ければ null', async () => {
    handlers.push((_q, s) => s.end(JSON.stringify({ size: '5' })));
    expect(await gcs().stat('a/b.pdf')).toEqual({ sizeBytes: 5, md5Base64: null });
  });

  it('不正な key は通信せずに拒否', async () => {
    await expect(gcs().get('../x')).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' });
    await expect(gcs().stat('/x')).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' });
    expect(seen).toHaveLength(0);
  });
});

describe('LocalFsStorage.stat', () => {
  it('保存した内容のサイズと MD5 を返す。無い key は NOT_FOUND', async () => {
    const s = new LocalFsStorage(await mkdtemp(join(tmpdir(), 'ix-stat-')));
    await s.put('x/y.pdf', pdf);
    expect(await s.stat('x/y.pdf')).toEqual({ sizeBytes: pdf.byteLength, md5Base64: md5Base64(pdf) });
    await expect(s.stat('x/none.pdf')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
