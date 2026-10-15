export interface LoginSuccessData {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly csrfToken: string;
}

export interface MfaChallengeData {
  readonly mfaRequired: true;
  readonly mfaEnrolled: boolean;
  readonly challenge: string;
  readonly challengeExpiresAt: string;
}

export type LoginOutcome =
  | { readonly kind: 'success'; readonly data: LoginSuccessData }
  /** CHG-012 管理者の多要素認証: 確認コードの入力（未登録なら登録）へ */
  | { readonly kind: 'mfa'; readonly data: MfaChallengeData }
  | { readonly kind: 'error'; readonly message: string };

function isMfaBody(value: unknown): value is { data: MfaChallengeData } {
  if (typeof value !== 'object' || value === null || !('data' in value)) return false;
  const d = (value as { data: unknown }).data as Record<string, unknown> | null;
  return d !== null && typeof d === 'object' && d['mfaRequired'] === true && typeof d['challenge'] === 'string' && typeof d['mfaEnrolled'] === 'boolean';
}

function isSuccessBody(value: unknown): value is { data: LoginSuccessData } {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    return false;
  }
  const data = (value as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['roles']) &&
    typeof candidate['csrfToken'] === 'string'
  );
}

function isErrorBody(value: unknown): value is { error: { code: string } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['code'] === 'string';
}

function loginErrorMessage(code: string, status: number): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'ログインIDまたはパスワードが正しくありません。';
    case 'ACCOUNT_LOCKED':
      return 'アカウントがロックされています。しばらく時間をおいてから再度お試しください。';
    case 'VALIDATION_ERROR':
      return '入力内容を確認してください。';
    case 'RATE_LIMITED':
      return 'しばらく時間をおいてから再度お試しください。';
    default:
      return `エラーが発生しました（${status}）。`;
  }
}

export function interpretLoginResponse(status: number, body: unknown): LoginOutcome {
  if (status === 200 && isMfaBody(body)) {
    return { kind: 'mfa', data: body.data };
  }
  if (status === 200 && isSuccessBody(body)) {
    return { kind: 'success', data: body.data };
  }
  if (isErrorBody(body)) {
    return { kind: 'error', message: loginErrorMessage(body.error.code, status) };
  }
  return { kind: 'error', message: '予期しないエラーが発生しました。しばらくしてから再度お試しください。' };
}
