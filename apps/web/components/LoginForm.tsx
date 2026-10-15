'use client';

import { useState, type FormEvent } from 'react';
import { interpretLoginResponse, type LoginSuccessData, type MfaChallengeData } from '../lib/auth/login-response';
import { MfaStep } from './MfaStep';

export const CSRF_TOKEN_STORAGE_KEY = 'inspexor_csrf_token';

export interface LoginFormProps {
  readonly onLoginSuccess: (data: LoginSuccessData) => void;
}

export function LoginForm({ onLoginSuccess }: LoginFormProps) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // CHG-012: 管理者の多要素認証（確認待ち）
  const [mfa, setMfa] = useState<MfaChallengeData | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password }),
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = interpretLoginResponse(response.status, body);

      if (outcome.kind === 'success') {
        try {
          window.sessionStorage.setItem(CSRF_TOKEN_STORAGE_KEY, outcome.data.csrfToken);
        } catch {
          // sessionStorageが使えない環境でもログイン自体は継続する
        }
        onLoginSuccess(outcome.data);
      } else if (outcome.kind === 'mfa') {
        setPassword('');
        setMfa(outcome.data);
      } else {
        setErrorMessage(outcome.message);
      }
    } catch {
      setErrorMessage('通信エラーが発生しました。ネットワーク状態を確認してください。');
    } finally {
      setSubmitting(false);
    }
  }

  if (mfa !== null) {
    return <MfaStep challenge={mfa} onSuccess={onLoginSuccess} onCancel={() => setMfa(null)} />;
  }

  return (
    <form onSubmit={handleSubmit} className="px-form" aria-busy={submitting}>
      <div className="px-field">
        <label htmlFor="loginId">ログインID</label>
        <input
          id="loginId"
          name="loginId"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={loginId}
          onChange={(event) => setLoginId(event.target.value)}
        />
      </div>
      <div className="px-field">
        <label htmlFor="password">パスワード</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {errorMessage !== null ? (
        <p role="alert" className="px-alert">
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" className="px-primary" disabled={submitting}>
        {submitting ? 'ログイン中…' : 'ログイン'}
      </button>
    </form>
  );
}
