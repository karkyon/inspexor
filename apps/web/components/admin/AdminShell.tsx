'use client';

/**
 * 管理画面の共通枠（v6.0 ワイヤーフレーム: 左ナビ＋上部バー）。/me でログイン状態とロールを確認し、
 * 未ログインは /login へ、管理画面のロール（OFFICE/ADMIN/AUDITOR）以外は権限なし表示にする。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { apiRequest, storeCsrfToken } from '../../lib/api/client';

export interface AdminUser {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly csrfToken?: string;
}

const AdminUserContext = createContext<AdminUser | null>(null);

export function useAdminUser(): AdminUser {
  const user = useContext(AdminUserContext);
  if (user === null) throw new Error('AdminShell の外で useAdminUser が呼ばれました');
  return user;
}

export function canEditMasters(user: AdminUser): boolean {
  return user.roles.includes('ADMIN');
}

const ADMIN_AREA_ROLES = ['OFFICE', 'ADMIN', 'AUDITOR'];

export function AdminShell({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; user: AdminUser } | { status: 'forbidden'; user: AdminUser }>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiRequest<AdminUser>('GET', '/me');
      if (cancelled) return;
      if (!res.ok) {
        router.replace('/login');
        return;
      }
      storeCsrfToken(res.data.csrfToken);
      setState(res.data.roles.some((r) => ADMIN_AREA_ROLES.includes(r)) ? { status: 'ready', user: res.data } : { status: 'forbidden', user: res.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function logout(): Promise<void> {
    await apiRequest('POST', '/auth/logout');
    router.replace('/login');
  }

  const user = state.status === 'loading' ? null : state.user;
  return (
    <div className="ix-shell">
      <aside className="ix-sidenav" aria-label="メインメニュー">
        <div className="ix-brand">
          <div className="ix-brandmark" aria-hidden="true">IX</div>
          <div>
            <b>INSPEXOR</b>
            <small>業務管理システム</small>
          </div>
        </div>
        <nav>
          <a className={`ix-navitem${pathname.startsWith('/admin/masters') ? ' active' : ''}`} href="/admin/masters/products" aria-current={pathname.startsWith('/admin/masters') ? 'page' : undefined}>
            <span>SCR-13</span>
            <b>マスター管理</b>
          </a>
          <a className="ix-navitem" href="/">
            <span>HOME</span>
            <b>ホーム</b>
          </a>
        </nav>
      </aside>
      <div className="ix-content">
        <header className="ix-appbar">
          <b>マスター管理</b>
          <div className="ix-spacer" />
          {user !== null ? (
            <div className="ix-user">
              <i aria-hidden="true">{user.displayName.slice(0, 1)}</i>
              <span>
                {user.displayName}
                <br />
                <small>{user.roles.join(' / ')}</small>
              </span>
              <button type="button" className="ix-btn" onClick={() => void logout()}>
                ログアウト
              </button>
            </div>
          ) : null}
        </header>
        <main className="ix-viewport" id="main">
          {state.status === 'loading' ? (
            <p className="ix-muted" aria-live="polite">
              読み込み中…
            </p>
          ) : state.status === 'forbidden' ? (
            <section className="ix-panel" role="alert">
              <h1>この画面を表示する権限がありません</h1>
              <p>マスター管理は事務・管理者・監査のロールで利用できます。</p>
              <a href="/">ホームへ戻る</a>
            </section>
          ) : (
            <AdminUserContext.Provider value={state.user}>{children}</AdminUserContext.Provider>
          )}
        </main>
      </div>
    </div>
  );
}
