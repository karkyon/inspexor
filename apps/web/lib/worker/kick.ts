/**
 * 確定・帳票操作の直後に worker（Cloud Run、IAM 認証）を起こす（CHG-006 §4「web が確定を保存した直後に worker を呼び出す」）。
 *   WORKER_URL 未設定（開発の常駐 worker）なら何もしない。
 *   認証は Cloud Run の metadata server から worker 宛の ID token を取得する（web のサービスアカウントに run.invoker を付与）。
 *   worker は仕事が無くなるまで処理してから応答するため、応答は待たない（要求が送られるまで最大 waitMs 待って返す）。
 *   失敗しても業務処理は成功のまま（Cloud Scheduler が15分ごとに worker を起動するため（CHG-016）、遅れて処理される）。
 */

export interface KickDeps {
  readonly workerUrl: string | undefined;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** 要求を送ってから戻るまでの最大待ち時間（ms） */
  readonly waitMs: number;
}

const METADATA_IDENTITY = 'http://metadata.google.internal/computeMetadata/v1/instance/service-account/identity';

let cached: { audience: string; token: string; expiresAt: number } | null = null;

/** worker 宛の ID token（有効期限 1時間。50分で取り直す） */
async function idToken(deps: KickDeps, audience: string): Promise<string> {
  if (cached !== null && cached.audience === audience && cached.expiresAt > deps.now()) return cached.token;
  const res = await deps.fetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`metadata identity HTTP ${res.status}`);
  const token = (await res.text()).trim();
  cached = { audience, token, expiresAt: deps.now() + 50 * 60_000 };
  return token;
}

export async function kickWorker(deps: KickDeps = defaultDeps()): Promise<'skipped' | 'sent' | 'failed'> {
  if (!deps.workerUrl) return 'skipped';
  const base = deps.workerUrl.replace(/\/+$/, '');
  try {
    const token = await idToken(deps, base);
    const req = deps
      .fetch(`${base}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000) })
      .then(async (res) => {
        await res.body?.cancel().catch(() => undefined);
        if (!res.ok) console.error('[worker-kick] worker HTTP', res.status);
      })
      .catch((error: unknown) => {
        const name = (error as { name?: string } | null)?.name;
        if (name !== 'TimeoutError' && name !== 'AbortError') console.error('[worker-kick]', error instanceof Error ? error.message : String(error));
      });
    await Promise.race([req, new Promise((r) => setTimeout(r, deps.waitMs))]);
    return 'sent';
  } catch (error) {
    console.error('[worker-kick]', error instanceof Error ? error.message : String(error));
    return 'failed';
  }
}

function defaultDeps(): KickDeps {
  return { workerUrl: process.env['WORKER_URL'], fetch: globalThis.fetch, now: () => Date.now(), waitMs: 500 };
}

/** route の応答が成功（2xx）なら worker を起こしてから返す */
export async function withWorkerKick(res: Response): Promise<Response> {
  if (res.status >= 200 && res.status < 300 && res.headers.get('idempotent-replayed') !== 'true') await kickWorker();
  return res;
}

/** 試験用 */
export function resetKickCacheForTest(): void {
  cached = null;
}
