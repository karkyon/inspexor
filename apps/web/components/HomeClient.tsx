'use client';

/**
 * ホーム（/）。未ログインなら SCR-01 ログイン、ログイン後はロールに応じたメニュー（現場入力・報告一覧・月次集計・マスター管理）。
 * 画面の配色・寸法は v6.0 ワイヤーフレーム（現場ホーム SCR-02 の welcome / bigactions、管理画面の左ナビ）に合わせる。
 */
import { useEffect, useState } from 'react';
import { toJstParts } from '@inspexor/domain';
import { LoginScreen } from './LoginScreen';
import { LogoutButton } from './LogoutButton';
import { interpretMeResponse, type MeData } from '../lib/auth/me-response';
import { storeCsrfToken } from '../lib/api/client';

const ADMIN_AREA_ROLES = ['OFFICE', 'ADMIN', 'AUDITOR'];
const FIELD_AREA_ROLES = ['FIELD', 'OFFICE', 'ADMIN'];
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

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
          storeCsrfToken(outcome.data.csrfToken);
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
    return (
      <div className="px-page">
        <p className="px-loading" aria-live="polite" aria-busy="true">
          読み込み中…
        </p>
      </div>
    );
  }

  if (view.status === 'authenticated') {
    return <HomeMenu user={view.user} onLoggedOut={() => setView({ status: 'unauthenticated' })} />;
  }

  return (
    <LoginScreen
      onLoginSuccess={(data) =>
        setView({
          status: 'authenticated',
          user: { userId: data.userId, displayName: data.displayName, roles: data.roles },
        })
      }
    />
  );
}

function HomeMenu({ user, onLoggedOut }: { readonly user: MeData; readonly onLoggedOut: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const jst = toJstParts(now);
  const [y, m, d] = jst.date.split('-').map(Number) as [number, number, number];
  const dow = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  const field = user.roles.some((r) => FIELD_AREA_ROLES.includes(r));
  const admin = user.roles.some((r) => ADMIN_AREA_ROLES.includes(r));
  const fieldCreates = user.roles.includes('FIELD') || user.roles.includes('OFFICE');
  const masterEdit = user.roles.includes('ADMIN');
  const roles = user.roles.join(' / ');

  return (
    <div className="px-page">
      <header className="px-appbar">
        <div className="px-brand">
          <span className="px-brandmark" aria-hidden="true">
            IX
          </span>
          <div>
            <b>INSPEXOR</b>
            <small>業務管理システム</small>
          </div>
        </div>
        <div className="px-spacer" />
        <div className="px-user">
          <span>
            {user.displayName}（{roles}）
          </span>
          <LogoutButton onLoggedOut={onLoggedOut} className="px-logout" errorClassName="px-logouterr" />
        </div>
      </header>

      <main className="px-viewport">
        <section className="px-welcome">
          <div>
            <small>
              {y}年{m}月{d}日（{dow}）
            </small>
            <h1>
              ようこそ、{user.displayName}さん（{roles}）
            </h1>
            <p>利用する画面を選んでください。</p>
          </div>
          <div className="px-clock" aria-hidden="true">
            {jst.time}
            <small>JST</small>
          </div>
        </section>

        <h2 className="px-sectiontitle">メニュー</h2>
        <nav className="px-menu" aria-label="メニュー">
          {field ? (
            <a className="px-card field" href="/field">
              <i aria-hidden="true">⚙</i>
              <b>現場入力へ</b>
              <span>{fieldCreates ? '作業日報・運搬実績を登録します（タブレット向け）' : '現場ホームと最近の登録を確認します（閲覧のみ）'}</span>
              <em aria-hidden="true">→</em>
            </a>
          ) : null}
          {admin ? (
            <>
              <a className="px-card records" href="/admin/records">
                <i aria-hidden="true">≡</i>
                <b>報告一覧へ（事務所）</b>
                <span>作業日報・運搬実績の確認、修正、PDF の再出力</span>
                <em aria-hidden="true">→</em>
              </a>
              <a className="px-card monthly" href="/admin/monthly">
                <i aria-hidden="true">Σ</i>
                <b>月次集計へ</b>
                <span>確定済み実績の集計と Excel・CSV 出力</span>
                <em aria-hidden="true">→</em>
              </a>
              <a className="px-card masters" href="/admin/masters/products">
                <i aria-hidden="true">⚑</i>
                <b>マスター管理へ</b>
                <span>{masterEdit ? 'お客様・品番・作業者などの登録と変更' : 'お客様・品番・作業者などの参照'}</span>
                <em aria-hidden="true">→</em>
              </a>
            </>
          ) : null}
        </nav>
        {!field && !admin ? <p className="px-foot">このアカウントで利用できる画面はありません。管理者に連絡してください。</p> : null}
        <p className="px-foot">INSPEXOR 業務管理システム</p>
      </main>
    </div>
  );
}
