/**
 * ブラウザから /api/v1 を呼ぶ共通クライアント。CSRF token（ログイン応答・/me で配布、sessionStorage保持）を付与し、
 * openapi の {data, meta} / {error} 形式を判別して返す。
 */
export const CSRF_STORAGE_KEY = 'inspexor_csrf_token';

export interface ApiFieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly ApiFieldError[];
  readonly currentVersion?: number;
  readonly changedFields?: readonly string[];
  /** CHG-012 SEC-026: この操作の前に再認証が必要（403） */
  readonly reauthRequired?: boolean;
  /** CHG-012: 429 のとき、再試行までの秒数 */
  readonly retryAfterSeconds?: number;
}

/**
 * CHG-012: 再認証が必要な操作（403 reauthRequired）を受けたときに呼ぶ処理（画面の再認証ダイアログが登録する）。
 * true が返れば同じ要求を1回だけ送り直す
 */
type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
export function setReauthHandler(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T; readonly meta?: { page: number; pageSize: number; total: number } | null }
  | { readonly ok: false; readonly status: number; readonly error: ApiError };

export function storeCsrfToken(token: string | undefined): void {
  if (token === undefined) return;
  try {
    window.sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    // sessionStorage 不可でも閲覧は継続
  }
}

function readCsrfToken(): string | null {
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<ApiResult<T>> {
  const first = await send<T>(method, path, body, extraHeaders);
  if (!first.ok && first.status === 403 && first.error.reauthRequired === true && reauthHandler !== null) {
    if (await reauthHandler()) return send<T>(method, path, body, extraHeaders);
  }
  return first;
}

async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = readCsrfToken();
    if (token !== null) headers['x-csrf-token'] = token;
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: '通信に失敗しました。ネットワーク状態を確認してください。' } };
  }
  if (response.status === 204) {
    return { ok: true, status: 204, data: undefined as T };
  }
  const json = (await response.json().catch(() => null)) as { data?: T; meta?: never; error?: ApiError } | null;
  if (response.ok && json !== null && 'data' in json) {
    return { ok: true, status: response.status, data: json.data as T, meta: json.meta ?? null };
  }
  return {
    ok: false,
    status: response.status,
    error:
      response.status === 429
        ? { ...(json?.error ?? { code: 'RATE_LIMITED' }), message: '操作が集中しています。しばらく時間をおいてから再度お試しください。' }
        : (json?.error ?? { code: 'UNKNOWN', message: `エラーが発生しました（${response.status}）。` }),
  };
}
