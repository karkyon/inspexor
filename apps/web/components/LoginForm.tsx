'use client';

import { useState, type FormEvent } from 'react';
import { interpretLoginResponse, type LoginSuccessData } from '../lib/auth/login-response';

export const CSRF_TOKEN_STORAGE_KEY = 'inspexor_csrf_token';

export interface LoginFormProps {
  readonly onLoginSuccess: (data: LoginSuccessData) => void;
}

export function LoginForm({ onLoginSuccess }: LoginFormProps) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      } else {
        setErrorMessage(outcome.message);
      }
    } catch {
      setErrorMessage('通信エラーが発生しました。ネットワーク状態を確認してください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <label htmlFor="loginId" style={{ display: 'block', marginBottom: 4 }}>
          ログインID
        </label>
        <input
          id="loginId"
          name="loginId"
          type="text"
          autoComplete="username"
          required
          value={loginId}
          onChange={(event) => setLoginId(event.target.value)}
          style={{ width: '100%', padding: 8 }}
        />
      </div>
      <div>
        <label htmlFor="password" style={{ display: 'block', marginBottom: 4 }}>
          パスワード
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ width: '100%', padding: 8 }}
        />
      </div>
      {errorMessage !== null ? (
        <p role="alert" style={{ color: '#b00020', margin: 0 }}>
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" disabled={submitting} style={{ padding: 10 }}>
        {submitting ? 'ログイン中…' : 'ログイン'}
      </button>
    </form>
  );
}
