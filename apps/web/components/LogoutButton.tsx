'use client';

import { useState } from 'react';
import { CSRF_TOKEN_STORAGE_KEY } from './LoginForm';
import { clearAllDrafts } from '../lib/field/draft-store';

export interface LogoutButtonProps {
  readonly onLoggedOut: () => void;
  readonly className?: string;
  readonly errorClassName?: string;
}

export function LogoutButton({ onLoggedOut, className, errorClassName }: LogoutButtonProps) {
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
        // REQ-OFF-001: logout で端末下書きを削除
        clearAllDrafts();
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
      <button type="button" onClick={handleClick} disabled={submitting} className={className} style={className === undefined ? { padding: 8 } : undefined}>
        {submitting ? 'ログアウト中…' : 'ログアウト'}
      </button>
      {errorMessage !== null ? (
        <p role="alert" className={errorClassName} style={errorClassName === undefined ? { color: '#b00020' } : undefined}>
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
