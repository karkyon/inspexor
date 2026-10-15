'use client';

/**
 * CHG-012 本人の多要素認証（管理者）。状態の表示と、回復コードの再発行（再認証が必要。古い回復コードは使えなくなる）。
 * 認証アプリの端末を替えるときは、他の管理者に「多要素認証の解除」を依頼し、次のログインで登録し直す。
 */
import { useEffect, useState } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest, type ApiError } from '../../lib/api/client';

interface MfaStatus {
  readonly required: boolean;
  readonly enrolled: boolean;
  readonly enabledAt: string | null;
  readonly recoveryCodesRemaining: number;
}

export function AccountScreen() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await apiRequest<MfaStatus>('GET', '/auth/mfa');
    if (res.ok) setStatus(res.data);
    else setError(res.error);
  }
  useEffect(() => {
    void load();
  }, []);

  async function regenerate() {
    setBusy(true);
    setError(null);
    const res = await apiRequest<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', {});
    setBusy(false);
    if (res.ok) {
      setCodes(res.data.recoveryCodes);
      await load();
    } else setError(res.error);
  }

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">アカウント</small>
          <h1>多要素認証</h1>
          <p>管理者はパスワードに加えて、認証アプリの確認コードでログインします。</p>
        </div>
      </header>
      {error !== null ? (
        <div className="ix-errorsummary" role="alert">
          <b>{error.message}</b>
        </div>
      ) : null}
      {status === null ? (
        <p className="ix-muted" aria-live="polite">
          読み込み中…
        </p>
      ) : (
        <section className="ix-panel" aria-labelledby="acc-status">
          <h2 id="acc-status">登録の状態</h2>
          <dl className="ix-dl">
            <dt>多要素認証</dt>
            <dd>{status.enrolled ? `登録済み（${status.enabledAt !== null ? `${toJstParts(new Date(status.enabledAt)).date} 登録` : ''}）` : '未登録（次のログインで登録します）'}</dd>
            <dt>回復コードの残り</dt>
            <dd>
              {status.recoveryCodesRemaining}個{status.enrolled && status.recoveryCodesRemaining <= 3 ? <b className="ix-red">（少なくなっています。再発行してください）</b> : null}
            </dd>
          </dl>
          {status.enrolled ? (
            <div className="ix-actions">
              <p className="ix-muted ix-small">再発行すると、今までの回復コードは使えなくなります。操作の前にパスワードと確認コードを確認します。</p>
              <button type="button" className="ix-btn" disabled={busy} onClick={() => void regenerate()}>
                回復コードを再発行
              </button>
            </div>
          ) : null}
          <p className="ix-muted ix-small">スマートフォンを替えたときは、他の管理者に利用者管理の「多要素認証の解除」を依頼してください。次のログインで登録し直します。</p>
        </section>
      )}
      {codes !== null ? (
        <section className="ix-panel" aria-labelledby="acc-codes">
          <h2 id="acc-codes">新しい回復コード</h2>
          <p role="status">この画面を閉じると二度と表示されません。印刷するか、安全な場所に書き写してください。各コードは1回だけ使えます。</p>
          <ol className="ix-codes" data-testid="mfa-recovery-codes">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
