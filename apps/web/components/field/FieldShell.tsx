'use client';

/**
 * 現場入力の共通枠（SCR-02〜09）。/me でログインとロールを確認し、未ログインは /login、
 * 利用者（FIELD/OFFICE/ADMIN）以外は権限なし表示。logout で端末下書きを削除（REQ-OFF-001）。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, storeCsrfToken } from '../../lib/api/client';
import { clearAllDrafts, resumeDrafts } from '../../lib/field/draft-store';
import { ReauthDialog } from '../ReauthDialog';
import { roleText } from '../../lib/auth/role-label';

export interface FieldUser {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly csrfToken?: string;
}

const FieldUserContext = createContext<FieldUser | null>(null);

export function useFieldUser(): FieldUser {
  const user = useContext(FieldUserContext);
  if (user === null) throw new Error('FieldShell の外で useFieldUser が呼ばれました');
  return user;
}

/** API-004/008 createWorkReport/createDeliveryReport の権限（FIELD/OFFICE） */
export function canCreateReports(user: FieldUser): boolean {
  return user.roles.includes('FIELD') || user.roles.includes('OFFICE');
}

const FIELD_AREA_ROLES = ['FIELD', 'OFFICE', 'ADMIN'];

export function FieldShell({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' | 'forbidden'; user: FieldUser }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiRequest<FieldUser>('GET', '/me');
      if (cancelled) return;
      if (!res.ok) {
        // 通信断で /me が取れない場合もログイン画面へ（オフラインのまま新規に開くことは想定外）
        router.replace('/login');
        return;
      }
      storeCsrfToken(res.data.csrfToken);
      resumeDrafts();
      setState({ status: res.data.roles.some((r) => FIELD_AREA_ROLES.includes(r)) ? 'ready' : 'forbidden', user: res.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function logout(): Promise<void> {
    await apiRequest('POST', '/auth/logout');
    clearAllDrafts();
    router.replace('/login');
  }

  const user = state.status === 'loading' ? null : state.user;
  return (
    <div className="fx-shell">
      <a className="fx-skip" href="#main">
        本文へ移動
      </a>
      <header className="fx-appbar">
        <a href="/field" aria-label="INSPEXOR 現場ホーム">
          <span className="fx-brandmark" aria-hidden="true">IX</span>
          <b>INSPEXOR 現場入力</b>
        </a>
        <div className="fx-spacer" />
        {user !== null ? (
          <div className="fx-user">
            <span>
              {user.displayName}（{roleText(user.roles)}）
            </span>
            <button type="button" onClick={() => void logout()}>
              ログアウト
            </button>
          </div>
        ) : null}
      </header>
      <main className="fx-viewport" id="main" tabIndex={-1}>
        {state.status === 'loading' ? (
          <p className="fx-muted" aria-live="polite" aria-busy="true">
            読み込み中…
          </p>
        ) : state.status === 'forbidden' ? (
          <section className="fx-card" role="alert" style={{ padding: 24 }}>
            <h1>この画面を表示する権限がありません</h1>
            <p>現場入力は現場・事務所・管理者の区分で利用できます。</p>
            <a href="/">ホームへ戻る</a>
          </section>
        ) : (
          <FieldUserContext.Provider value={state.user}>{children}</FieldUserContext.Provider>
        )}
      </main>
      <ReauthDialog />
    </div>
  );
}
