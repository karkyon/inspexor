import { afterEach, describe, expect, it } from 'vitest';
import { kickWorker, resetKickCacheForTest, type KickDeps } from './kick';

afterEach(() => resetKickCacheForTest());

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}

const deps = (f: typeof fetch, over: Partial<KickDeps> = {}): KickDeps => ({ workerUrl: 'https://worker.example.run.app/', fetch: f, now: () => 0, waitMs: 50, ...over });

describe('kickWorker（確定直後に worker を起こす）', () => {
  it('WORKER_URL が無ければ何もしない（開発の常駐 worker）', async () => {
    const { f, calls } = fakeFetch(async () => new Response('x'));
    expect(await kickWorker(deps(f, { workerUrl: undefined }))).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('metadata server から worker 宛の ID token を取り、POST /run に付ける。token は使い回す', async () => {
    const { f, calls } = fakeFetch(async (url) => (url.startsWith('http://metadata') ? new Response('id-token-1\n') : new Response('{}')));
    expect(await kickWorker(deps(f))).toBe('sent');
    expect(await kickWorker(deps(f))).toBe('sent');
    const meta = calls.filter((c) => c.url.startsWith('http://metadata'));
    expect(meta).toHaveLength(1);
    expect(meta[0]?.url).toContain(`audience=${encodeURIComponent('https://worker.example.run.app')}`);
    expect((meta[0]?.init?.headers as Record<string, string>)['Metadata-Flavor']).toBe('Google');
    const run = calls.filter((c) => c.url === 'https://worker.example.run.app/run');
    expect(run).toHaveLength(2);
    expect(run[0]?.init?.method).toBe('POST');
    expect((run[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer id-token-1');
  });

  it('worker の処理完了（応答）は待たずに返る', async () => {
    const { f } = fakeFetch(async (url) => (url.startsWith('http://metadata') ? new Response('t') : new Promise<Response>(() => undefined)));
    const t = Date.now();
    expect(await kickWorker(deps(f, { waitMs: 30 }))).toBe('sent');
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it('token を取れなければ failed（例外は投げない）', async () => {
    const { f, calls } = fakeFetch(async () => new Response('', { status: 404 }));
    expect(await kickWorker(deps(f))).toBe('failed');
    expect(calls.filter((c) => c.url.endsWith('/run'))).toHaveLength(0);
  });
});
