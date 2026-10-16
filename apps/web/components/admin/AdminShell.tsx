'use client';

/**
 * 管理画面の共通枠（v6.0 ワイヤーフレーム: 左ナビ＋上部バー）。/me でログイン状態とロールを確認し、
 * 未ログインは /login へ、管理画面のロール（OFFICE/ADMIN/AUDITOR）以外は権限なし表示にする。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { apiRequest, storeCsrfToken } from '../../lib/api/client';
import { clearAllDrafts } from '../../lib/field/draft-store';
import { ReauthDialog } from '../ReauthDialog';
import { roleText } from '../../lib/auth/role-label';

export interface AdminFeatures {
  readonly approval: boolean;
  readonly billing: boolean;
  readonly dailyMail: boolean;
  /** CHG-012 管理者の多要素認証 */
  readonly adminMfa?: boolean;
}

export interface AdminUser {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly csrfToken?: string;
  /** CHG-007: 有効な機能（提案書の対象外機能は既定で無効） */
  readonly features?: AdminFeatures;
}

export function hasFeature(user: AdminUser | null, feature: keyof AdminFeatures): boolean {
  return user?.features?.[feature] === true;
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

/** CHG-004: 提案書 P.6 の事務所 Web 管理画面（報告一覧・月次集計・マスタ管理） */
interface NavItem {
  readonly prefix: string;
  /** CHG-011: このメニューを選択中にする他の path（請求書 /admin/invoices は「請求」） */
  readonly also?: readonly string[];
  readonly href: string;
  /** 画面幅 900px 以下で名称の代わりに出す短い表示（K-02: 開発用の画面番号は出さない） */
  readonly code: string;
  readonly label: string;
  /** CHG-007: この機能が有効なときだけ出す */
  readonly feature?: keyof AdminFeatures;
  /** このロールのどれかを持つときだけ出す */
  readonly roles?: readonly string[];
}

const NAV: readonly NavItem[] = [
  { prefix: '/admin/dashboard', href: '/admin/dashboard', code: 'ダッシュ', label: 'ダッシュボード', feature: 'approval' },
  { prefix: '/admin/records', href: '/admin/records', code: '一覧', label: '報告一覧' },
  { prefix: '/admin/monthly', href: '/admin/monthly', code: '集計', label: '月次集計' },
  { prefix: '/admin/billing', also: ['/admin/invoices'], href: '/admin/billing', code: '請求', label: '請求', feature: 'billing' },
  { prefix: '/admin/masters', href: '/admin/masters/products', code: 'マスタ', label: 'マスター管理' },
  { prefix: '/admin/users', href: '/admin/users', code: '利用者', label: '利用者管理' },
  { prefix: '/admin/account', href: '/admin/account', code: 'MFA', label: '多要素認証', feature: 'adminMfa', roles: ['ADMIN'] },
];

function matches(n: NavItem, pathname: string): boolean {
  return pathname.startsWith(n.prefix) || (n.also ?? []).some((p) => pathname.startsWith(p));
}

function visibleNav(user: AdminUser | null): NavItem[] {
  return NAV.filter((n) => (n.feature === undefined || hasFeature(user, n.feature)) && (n.roles === undefined || (user !== null && user.roles.some((r) => n.roles?.includes(r)))));
}

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
    clearAllDrafts();
    router.replace('/login');
  }

  const user = state.status === 'loading' ? null : state.user;
  return (
    <div className="ix-shell">
      <a className="ix-skip" href="#main">
        本文へ移動
      </a>
      <aside className="ix-sidenav" aria-label="メインメニュー">
        <div className="ix-brand">
          <div className="ix-brandmark" aria-hidden="true">IX</div>
          <div>
            <b>INSPEXOR</b>
            <small>業務管理システム</small>
          </div>
        </div>
        <nav>
          {visibleNav(user).map((n) => {
            const active = matches(n, pathname);
            return (
              <a key={n.prefix} className={`ix-navitem${active ? ' active' : ''}`} href={n.href} aria-current={active ? 'page' : undefined}>
                <span>{n.code}</span>
                <b>{n.label}</b>
              </a>
            );
          })}
          <a className="ix-navitem" href="/">
            <span>ホーム</span>
            <b>ホーム</b>
          </a>
        </nav>
      </aside>
      <div className="ix-content">
        <header className="ix-appbar">
          <b>{NAV.find((n) => matches(n, pathname))?.label ?? '管理'}</b>
          <div className="ix-spacer" />
          {user !== null ? (
            <div className="ix-user">
              <i aria-hidden="true">{user.displayName.slice(0, 1)}</i>
              <span>
                {user.displayName}
                <br />
                <small>{roleText(user.roles)}</small>
              </span>
              <button type="button" className="ix-btn" onClick={() => void logout()}>
                ログアウト
              </button>
            </div>
          ) : null}
        </header>
        <main className="ix-viewport" id="main" tabIndex={-1}>
          {state.status === 'loading' ? (
            <p className="ix-muted" aria-live="polite">
              読み込み中…
            </p>
          ) : state.status === 'forbidden' ? (
            <section className="ix-panel" role="alert">
              <h1>この画面を表示する権限がありません</h1>
              <p>事務所の画面は事務所・管理者・監査の区分で利用できます。</p>
              <a href="/">ホームへ戻る</a>
            </section>
          ) : (
            <AdminUserContext.Provider value={state.user}>{children}</AdminUserContext.Provider>
          )}
        </main>
        <ReauthDialog />
      </div>
    </div>
  );
}
