'use client';

/**
 * CHG-012 SEC-026 再認証ダイアログ。代理入力・パスワード再設定・多要素認証の解除・回復コードの再発行などで、
 * API が 403 reauthRequired を返したときに開き、パスワード（多要素認証の登録者は確認コードも）を確かめてから同じ操作を送り直す。
 * 画面の枠（AdminShell・FieldShell）に1つ置く。<dialog> のモーダル表示（Esc で閉じる、フォーカスはダイアログ内）
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { apiRequest, setReauthHandler } from '../lib/api/client';

const box: CSSProperties = { width: 'min(440px, calc(100vw - 32px))', border: '1px solid #b8c7d2', borderRadius: 12, padding: 22, boxShadow: '0 16px 40px #10283c40', color: '#172b3a' };
const field: CSSProperties = { display: 'block', width: '100%', minHeight: 44, border: '1px solid #8fa5b4', borderRadius: 8, padding: '10px 12px', fontSize: 16, marginTop: 6 };
const btn: CSSProperties = { minHeight: 44, padding: '0 18px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' };

export function ReauthDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { title: useId(), desc: useId(), pw: useId(), code: useId(), err: useId() };

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setPassword('');
          setCode('');
          setError(null);
          setUseRecovery(false);
          void apiRequest<{ required: boolean; enrolled: boolean }>('GET', '/auth/mfa').then((r) => setNeedCode(r.ok && r.data.required && r.data.enrolled));
          ref.current?.showModal();
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  function close(ok: boolean) {
    ref.current?.close();
    resolver.current?.(ok);
    resolver.current = null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password === '' || (needCode && code.trim() === '')) {
      setError(password === '' ? 'パスワードを入力してください。' : '確認コードを入力してください。');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await apiRequest<{ authAt: string }>('POST', '/auth/reauth', { password, ...(needCode ? (useRecovery ? { recoveryCode: code } : { code }) : {}) });
    setBusy(false);
    if (res.ok) {
      setPassword('');
      setCode('');
      close(true);
      return;
    }
    setError(res.error.message);
  }

  return (
    <dialog ref={ref} style={box} aria-labelledby={ids.title} aria-describedby={ids.desc} onCancel={(e) => { e.preventDefault(); close(false); }}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <h2 id={ids.title} style={{ margin: '0 0 8px', fontSize: 19 }}>
          本人確認
        </h2>
        <p id={ids.desc} style={{ margin: '0 0 14px', color: '#4d5f6c' }}>
          この操作の前に、もう一度パスワード{needCode ? 'と確認コード' : ''}を入力してください（10分間有効）。
        </p>
        <label htmlFor={ids.pw} style={{ fontWeight: 700 }}>
          あなたのパスワード
        </label>
        <input id={ids.pw} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={field} aria-invalid={error !== null || undefined} aria-describedby={error !== null ? ids.err : undefined} autoFocus />
        {needCode ? (
          <div style={{ marginTop: 12 }}>
            <label htmlFor={ids.code} style={{ fontWeight: 700 }}>
              {useRecovery ? 'あなたの回復コード' : 'あなたの確認コード（6桁）'}
            </label>
            <input id={ids.code} type="text" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} style={field} />
            <button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }} style={{ ...btn, border: 0, background: 'none', color: '#1769aa', textDecoration: 'underline', padding: 0 }}>
              {useRecovery ? '確認コードを使う' : '回復コードを使う'}
            </button>
          </div>
        ) : null}
        {error !== null ? (
          <p id={ids.err} role="alert" style={{ margin: '12px 0 0', padding: '8px 12px', borderRadius: 8, background: '#fde7e7', color: '#a42a2a', fontWeight: 700 }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" onClick={() => close(false)} style={{ ...btn, border: '1px solid #8fa5b4', background: '#fff' }}>
            やめる
          </button>
          <button type="submit" disabled={busy} style={{ ...btn, border: 0, background: '#1769aa', color: '#fff' }}>
            {busy ? '確認しています…' : '確認して続ける'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
