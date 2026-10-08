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

export async function apiRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
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
    error: json?.error ?? { code: 'UNKNOWN', message: `エラーが発生しました（${response.status}）。` },
  };
}
