'use client';

/**
 * CHG-012 ログインの2段階目（管理者の多要素認証）。
 *   未登録: QR コード（または秘密鍵の手入力）で認証アプリに登録 → 確認コード → 回復コード10個を表示（保存したことを確認してから進む）
 *   登録済み: 認証アプリの確認コード（または回復コード）
 * 確認待ちの期限（5分）が切れたら、ログインからやり直す
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { LoginSuccessData, MfaChallengeData } from '../lib/auth/login-response';

interface SetupData {
  readonly challenge: string;
  readonly secret: string;
  readonly otpauthUri: string;
  readonly qrSvg: string;
}

type ErrorBody = { error?: { code?: string; message?: string; challengeExpired?: boolean; retryAfterSeconds?: number } };

async function postJson(path: string, body: unknown): Promise<{ status: number; json: { data?: unknown } & ErrorBody }> {
  const res = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const json = ((await res.json().catch(() => ({}))) ?? {}) as { data?: unknown } & ErrorBody;
  return { status: res.status, json };
}

function messageOf(status: number, body: ErrorBody): string {
  if (status === 429) return 'しばらく時間をおいてから再度お試しください。';
  if (status === 423) return 'アカウントがロックされています。しばらく時間をおいてから再度お試しください。';
  return body.error?.message ?? `エラーが発生しました（${status}）。`;
}

export function MfaStep({ challenge, onSuccess, onCancel }: { readonly challenge: MfaChallengeData; readonly onSuccess: (data: LoginSuccessData) => void; readonly onCancel: () => void }) {
  const [token, setToken] = useState(challenge.challenge);
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ data: LoginSuccessData; codes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = { code: useId(), help: useId(), saved: useId() };

  useEffect(() => {
    headingRef.current?.focus();
    if (challenge.mfaEnrolled) return;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      const r = await postJson('/auth/mfa/setup', { challenge: challenge.challenge });
      setBusy(false);
      if (cancelled) return;
      if (r.status === 200) {
        const d = r.json.data as SetupData;
        setSetup(d);
        setToken(d.challenge);
      } else {
        setExpired(r.json.error?.challengeExpired === true);
        setError(messageOf(r.status, r.json));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [challenge]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (code.trim() === '') {
      setError(useRecovery ? '回復コードを入力してください。' : '確認コード（6桁）を入力してください。');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await postJson('/auth/mfa/verify', { challenge: token, ...(useRecovery ? { recoveryCode: code } : { code }) });
    setBusy(false);
    if (r.status === 200) {
      const data = r.json.data as LoginSuccessData & { recoveryCodes?: string[] };
      try {
        window.sessionStorage.setItem('inspexor_csrf_token', data.csrfToken);
      } catch {
        // sessionStorage が使えない環境でもログインは続ける
      }
      if (data.recoveryCodes !== undefined) setDone({ data, codes: data.recoveryCodes });
      else onSuccess(data);
      return;
    }
    setExpired(r.json.error?.challengeExpired === true);
    setError(messageOf(r.status, r.json));
    setCode('');
    inputRef.current?.focus();
  }

  if (done !== null) {
    return (
      <section className="px-form" aria-labelledby="mfa-done-title">
        <h3 id="mfa-done-title" ref={headingRef} tabIndex={-1} className="px-steptitle">
          回復コードを保存してください
        </h3>
        <p className="px-lead">
          認証アプリを使えなくなったとき（スマートフォンの紛失・機種変更）に、確認コードの代わりに使います。各コードは1回だけ使えます。この画面を閉じると二度と表示されません。印刷するか、安全な場所に書き写してください。
        </p>
        <ol className="px-codes" data-testid="mfa-recovery-codes" aria-label="回復コード（10個）">
          {done.codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>
        <div className="px-check">
          <input id={ids.saved} type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <label htmlFor={ids.saved}>回復コードを安全な場所に保存しました</label>
        </div>
        <button type="button" className="px-primary" disabled={!saved} onClick={() => onSuccess(done.data)}>
          続ける
        </button>
      </section>
    );
  }

  const enrolling = !challenge.mfaEnrolled;
  return (
    <form className="px-form" onSubmit={(e) => void submit(e)} aria-busy={busy} aria-labelledby="mfa-title" noValidate>
      <h3 id="mfa-title" ref={headingRef} tabIndex={-1} className="px-steptitle">
        {enrolling ? '多要素認証の登録' : '確認コードの入力'}
      </h3>
      {enrolling ? (
        <>
          <p className="px-lead">
            管理者は、パスワードに加えて認証アプリ（Google Authenticator、Microsoft Authenticator など）の確認コードでログインします。スマートフォンの認証アプリで下の QR コードを読み取ってください。
          </p>
          {setup !== null ? (
            <div className="px-qr">
              <div role="img" aria-label="認証アプリに登録する QR コード" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
              <p>
                読み取れないときは、認証アプリに次のキーを手入力してください（時間ベース）。
                <br />
                <code className="px-secret" data-testid="mfa-secret">
                  {setup.secret}
                </code>
              </p>
            </div>
          ) : !error ? (
            <p aria-live="polite">準備しています…</p>
          ) : null}
        </>
      ) : (
        <p className="px-lead">{useRecovery ? '回復コード（XXXX-XXXX）を入力してください。使った回復コードは使えなくなります。' : '認証アプリに表示されている6桁の確認コードを入力してください。'}</p>
      )}
      <div className="px-field">
        <label htmlFor={ids.code}>{useRecovery ? '回復コード' : '確認コード（6桁）'}</label>
        <input
          id={ids.code}
          ref={inputRef}
          name={useRecovery ? 'recoveryCode' : 'code'}
          type="text"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoCapitalize={useRecovery ? 'characters' : 'none'}
          spellCheck={false}
          maxLength={useRecovery ? 12 : 8}
          value={code}
          aria-describedby={error !== null ? ids.help : undefined}
          aria-invalid={error !== null || undefined}
          onChange={(e) => setCode(e.target.value)}
          disabled={expired || (enrolling && setup === null)}
        />
      </div>
      {error !== null ? (
        <p role="alert" className="px-alert" id={ids.help}>
          {error}
        </p>
      ) : null}
      {expired ? (
        <button type="button" className="px-primary" onClick={onCancel}>
          ログインに戻る
        </button>
      ) : (
        <button type="submit" className="px-primary" disabled={busy || (enrolling && setup === null)}>
          {busy ? '確認しています…' : enrolling ? '登録してログイン' : 'ログイン'}
        </button>
      )}
      <div className="px-linkrow">
        {!enrolling && !expired ? (
          <button
            type="button"
            className="px-textbtn"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
              setError(null);
              inputRef.current?.focus();
            }}
          >
            {useRecovery ? '確認コードを使う' : '認証アプリを使えない（回復コードを使う）'}
          </button>
        ) : null}
        {!expired ? (
          <button type="button" className="px-textbtn" onClick={onCancel}>
            ログインに戻る
          </button>
        ) : null}
      </div>
    </form>
  );
}
