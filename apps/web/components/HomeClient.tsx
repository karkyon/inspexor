'use client';

import { useEffect, useState } from 'react';
import { LoginForm } from './LoginForm';
import { LogoutButton } from './LogoutButton';
import { interpretMeResponse, type MeData } from '../lib/auth/me-response';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'authenticated'; readonly user: MeData }
  | { readonly status: 'unauthenticated' };

export function HomeClient() {
  const [view, setView] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function loadMe(): Promise<void> {
      try {
        const response = await fetch('/api/v1/me');
        const body: unknown = await response.json().catch(() => null);
        const outcome = interpretMeResponse(response.status, body);
        if (cancelled) {
          return;
        }
        if (outcome.kind === 'authenticated') {
          setView({ status: 'authenticated', user: outcome.data });
        } else {
          setView({ status: 'unauthenticated' });
        }
      } catch {
        if (!cancelled) {
          setView({ status: 'unauthenticated' });
        }
      }
    }

    void loadMe();
    return () => {
      cancelled = true;
    };
  }, []);

  if (view.status === 'loading') {
    return <p>読み込み中…</p>;
  }

  if (view.status === 'authenticated') {
    return (
      <div>
        <p>
          ようこそ、{view.user.displayName}さん（{view.user.roles.join(', ')}）
        </p>
        <LogoutButton onLoggedOut={() => setView({ status: 'unauthenticated' })} />
      </div>
    );
  }

  return (
    <div>
      <p>ログインしてください。</p>
      <LoginForm
        onLoginSuccess={(data) =>
          setView({
            status: 'authenticated',
            user: { userId: data.userId, displayName: data.displayName, roles: data.roles },
          })
        }
      />
    </div>
  );
}
