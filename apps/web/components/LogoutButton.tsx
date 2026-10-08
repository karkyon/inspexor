'use client';

import { useState } from 'react';
import { CSRF_TOKEN_STORAGE_KEY } from './LoginForm';

export interface LogoutButtonProps {
  readonly onLoggedOut: () => void;
}

export function LogoutButton({ onLoggedOut }: LogoutButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    setSubmitting(true);
    setErrorMessage(null);

    let csrfToken: string | null = null;
    try {
      csrfToken = window.sessionStorage.getItem(CSRF_TOKEN_STORAGE_KEY);
    } catch {
      csrfToken = null;
    }

    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: csrfToken !== null ? { 'X-CSRF-Token': csrfToken } : {},
      });
      if (response.status === 204) {
        try {
          window.sessionStorage.removeItem(CSRF_TOKEN_STORAGE_KEY);
        } catch {
          // 無視して続行
        }
        onLoggedOut();
      } else {
        setErrorMessage('ログアウトに失敗しました。');
      }
    } catch {
      setErrorMessage('通信エラーが発生しました。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={handleClick} disabled={submitting} style={{ padding: 8 }}>
        {submitting ? 'ログアウト中…' : 'ログアウト'}
      </button>
      {errorMessage !== null ? (
        <p role="alert" style={{ color: '#b00020' }}>
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
