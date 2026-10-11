'use client';

/**
 * CHG-008 利用者管理（ADMIN: 追加・表示名とロールの変更・無効化/有効化・パスワード再設定・ロック解除、OFFICE/AUDITOR: 参照）。
 * API-030〜033。パスワードは画面で生成でき、利用者に伝えるために一度だけ表示する（保存はハッシュのみ）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { useAdminUser } from './AdminShell';

export interface UserRow {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly locked: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const ROLE_LABEL: Readonly<Record<string, string>> = { FIELD: '現場', OFFICE: '事務', ADMIN: '管理者', AUDITOR: '監査' };
const ROLE_HELP: Readonly<Record<string, string>> = {
  FIELD: '作業日報・運搬実績の入力（自分の報告のみ）',
  OFFICE: '全報告の確認・修正・PDF再出力・月次集計',
  ADMIN: 'マスター・利用者の管理',
  AUDITOR: '参照とダウンロードのみ',
};
const ROLES = ['FIELD', 'OFFICE', 'ADMIN', 'AUDITOR'] as const;

function when(iso: string): string {
  const p = toJstParts(new Date(iso));
  return `${p.date} ${p.time}`;
}

/** 読みやすいパスワード（紛らわしい文字を除く 16 文字） */
export function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

function useUsers(): { rows: UserRow[] | null; error: string | null; reload: () => Promise<void> } {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const res = await apiRequest<UserRow[]>('GET', '/users');
    if (res.ok) {
      setRows(res.data);
      setError(null);
    } else setError(res.error.message);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { rows, error, reload };
}

function StatusPills({ u }: { u: UserRow }) {
  return (
    <>
      <span className={`ix-pill ${u.status === 'ACTIVE' ? 'approved' : 'draft'}`}>{u.status === 'ACTIVE' ? '有効' : '無効'}</span>
      {u.locked ? <span className="ix-pill rejected"> ロック中</span> : null}
    </>
  );
}

export function UsersScreen({ notice }: { readonly notice?: string | undefined }) {
  const user = useAdminUser();
  const isAdmin = user.roles.includes('ADMIN');
  const { rows, error } = useUsers();
  const [q, setQ] = useState('');
  const shown = (rows ?? []).filter((u) => q === '' || u.loginId.includes(q) || u.displayName.includes(q));

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">設定</small>
          <h1>利用者管理</h1>
          <p>ログインできる人と、使える画面（ロール）を管理します。利用をやめた人は削除せず無効にします。</p>
        </div>
        {isAdmin ? (
          <a className="ix-btn primary" href="/admin/users/new">
            ＋ 利用者を追加
          </a>
        ) : null}
      </header>
      {notice !== undefined ? (
        <p className="ix-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="ix-searchbar">
        <label className="ix-visually-hidden" htmlFor="user-q">
          ログインID・表示名で検索
        </label>
        <input id="user-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ログインID・表示名で検索" />
      </div>
      <section className="ix-datatable" aria-label="利用者一覧">
        {error !== null ? (
          <p role="alert">{error}</p>
        ) : rows === null ? (
          <p aria-busy="true">読み込み中…</p>
        ) : (
          <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>ログインID</th>
                  <th>表示名</th>
                  <th>ロール</th>
                  <th>状態</th>
                  <th>更新日時</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <a href={`/admin/users/${u.id}`}>
                        <b>{u.loginId}</b>
                      </a>
                    </td>
                    <td>{u.displayName}</td>
                    <td>{u.roles.map((r) => ROLE_LABEL[r] ?? r).join('・')}</td>
                    <td>
                      <StatusPills u={u} />
                    </td>
                    <td>{when(u.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer>
          <span>{shown.length}件</span>
        </footer>
      </section>
    </div>
  );
}

function RoleChecks({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <fieldset className="ix-field" disabled={disabled}>
      <span>
        ロール<span className="ix-req">必須</span>
      </span>
      <div className="ix-checklist">
        {ROLES.map((r) => (
          <label key={r}>
            <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
            <b>{ROLE_LABEL[r]}</b> <small className="ix-muted">{ROLE_HELP[r]}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PasswordField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="ix-field">
      <label htmlFor={id}>
        パスワード（12文字以上）<span className="ix-req">必須</span>
      </label>
      <div className="ix-pwrow">
        <input id={id} type={shown ? 'text' : 'password'} autoComplete="new-password" value={value} maxLength={128} onChange={(e) => onChange(e.target.value)} />
        <button
          type="button"
          className="ix-btn"
          onClick={() => {
            onChange(generatePassword());
            setShown(true);
          }}
        >
          自動生成
        </button>
        <button type="button" className="ix-btn" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? '隠す' : '表示'}
        </button>
      </div>
      <small className="ix-muted">本人に安全な方法で伝えてください。画面を閉じると再表示できません（忘れた場合は再設定）。</small>
    </div>
  );
}

type Fields = Array<{ path: string; message: string }>;

function FieldErrors({ fields }: { fields: Fields }) {
  if (fields.length === 0) return null;
  return (
    <div className="ix-errorsummary" role="alert">
      <b>入力内容を確認してください</b>
      <ul>
        {fields.map((f) => (
          <li key={f.path + f.message}>{f.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function UserCreateScreen() {
  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<string[]>(['FIELD']);
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Fields>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const res = await apiRequest('POST', '/users', { loginId: loginId.trim(), displayName: displayName.trim(), roles, password });
    setBusy(false);
    if (res.ok) {
      window.location.assign('/admin/users?saved=created');
      return;
    }
    setFields(res.error.fields?.map((f) => ({ path: f.path, message: f.message })) ?? [{ path: '/', message: res.error.message }]);
  }

  return (
    <div className="ix-page ix-editor">
      <header className="ix-pagehead">
        <div>
          <a href="/admin/users" className="ix-small">
            ← 利用者一覧
          </a>
          <h1>利用者を追加</h1>
        </div>
      </header>
      <form className="ix-panel ix-form" onSubmit={(e) => void submit(e)}>
        <FieldErrors fields={fields} />
        <div className="ix-formgrid">
          <div className="ix-field">
            <label htmlFor="u-login">
              ログインID<span className="ix-req">必須</span>
            </label>
            <input id="u-login" value={loginId} maxLength={100} autoCapitalize="none" spellCheck={false} onChange={(e) => setLoginId(e.target.value)} placeholder="例: tanaka.k" />
            <small className="ix-muted">3〜100文字の英数字と . _ @ -。あとから変更できません。</small>
          </div>
          <div className="ix-field">
            <label htmlFor="u-name">
              表示名<span className="ix-req">必須</span>
            </label>
            <input id="u-name" value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} placeholder="例: 田中 一郎" />
          </div>
        </div>
        <RoleChecks value={roles} onChange={setRoles} />
        <PasswordField id="u-pw" value={password} onChange={setPassword} />
        <div className="ix-actions">
          <a className="ix-btn" href="/admin/users">
            キャンセル
          </a>
          <button type="submit" className="ix-btn primary" disabled={busy}>
            登録する
          </button>
        </div>
      </form>
    </div>
  );
}

export function UserDetailScreen({ id }: { readonly id: string }) {
  const me = useAdminUser();
  const isAdmin = me.roles.includes('ADMIN');
  const { rows, error, reload } = useUsers();
  const u = rows?.find((r) => r.id === id) ?? null;
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState<Fields>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (u !== null) {
      setDisplayName(u.displayName);
      setRoles(u.roles);
    }
  }, [u?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error !== null) return <section className="ix-panel" role="alert">{error}</section>;
  if (rows === null) return <p className="ix-muted">読み込み中…</p>;
  if (u === null)
    return (
      <section className="ix-panel" role="alert">
        <h1>利用者が見つかりません</h1>
        <a href="/admin/users">利用者一覧へ戻る</a>
      </section>
    );
  const self = u.id === me.userId;

  async function run(method: 'PATCH' | 'POST', path: string, body: Record<string, unknown>, done: string): Promise<void> {
    setBusy(true);
    setFields([]);
    setNotice(null);
    const res = await apiRequest(method, path, body);
    // 最新の version を読み込んでから結果を表示する（続けて操作しても競合しない）
    await reload();
    setBusy(false);
    if (res.ok) {
      setNotice(done);
      setPassword('');
      setReason('');
      return;
    }
    setFields(res.error.code === 'VERSION_CONFLICT' ? [{ path: '/', message: '他の利用者が更新しました。最新の内容を読み込みました。' }] : (res.error.fields?.map((f) => ({ path: f.path, message: f.message })) ?? [{ path: '/', message: res.error.message }]));
  }

  return (
    <div className="ix-page ix-editor">
      <header className="ix-pagehead">
        <div>
          <a href="/admin/users" className="ix-small">
            ← 利用者一覧
          </a>
          <h1>
            {u.loginId} {self ? <small className="ix-muted">（自分）</small> : null}
          </h1>
          <p>
            <StatusPills u={u} /> 作成 {when(u.createdAt)}・更新 {when(u.updatedAt)}
          </p>
        </div>
      </header>
      {notice !== null ? (
        <p className="ix-notice" role="status">
          {notice}
        </p>
      ) : null}
      <FieldErrors fields={fields} />
      <form
        className="ix-panel ix-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run('PATCH', `/users/${u.id}`, { expectedVersion: u.version, displayName: displayName.trim(), roles }, '保存しました。ロールを変えた場合、その利用者は再ログインが必要です。');
        }}
      >
        <h2>基本情報</h2>
        <div className="ix-field">
          <label htmlFor="u-name">
            表示名<span className="ix-req">必須</span>
          </label>
          <input id="u-name" value={displayName} maxLength={100} disabled={!isAdmin} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <RoleChecks value={roles} onChange={setRoles} disabled={!isAdmin} />
        {isAdmin ? (
          <div className="ix-actions">
            <span />
            <button type="submit" className="ix-btn primary" disabled={busy}>
              保存する
            </button>
          </div>
        ) : (
          <p className="ix-muted ix-small">変更は管理者だけが行えます。</p>
        )}
      </form>
      {isAdmin ? (
        <>
          <section className="ix-panel ix-form ix-inner" aria-labelledby="pw-title">
            <h2 id="pw-title">パスワードの再設定</h2>
            <p className="ix-muted ix-small">再設定すると、この利用者のログイン中の画面はすべてログアウトされ、ロックも解除されます。</p>
            <PasswordField id="u-pw" value={password} onChange={setPassword} />
            <div className="ix-actions">
              <span />
              <button type="button" className="ix-btn primary" disabled={busy} onClick={() => void run('POST', `/users/${u.id}/reset-password`, { expectedVersion: u.version, password }, 'パスワードを再設定しました。')}>
                パスワードを再設定
              </button>
            </div>
          </section>
          <section className="ix-panel ix-form ix-inner" aria-labelledby="st-title">
            <h2 id="st-title">利用の停止・再開</h2>
            {u.locked ? (
              <div className="ix-actions">
                <span>パスワードを続けて間違えたため、一時的にロックされています。</span>
                <button type="button" className="ix-btn" disabled={busy} onClick={() => void run('POST', `/users/${u.id}/unlock`, { expectedVersion: u.version }, 'ロックを解除しました。')}>
                  ロックを解除
                </button>
              </div>
            ) : null}
            <div className="ix-field">
              <label htmlFor="u-reason">理由（任意。監査記録に残ります）</label>
              <input id="u-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder={u.status === 'ACTIVE' ? '例: 退職のため' : '例: 復職のため'} />
            </div>
            <div className="ix-actions">
              <span className="ix-muted ix-small">{u.status === 'ACTIVE' ? '無効にすると、すぐにログインできなくなります（報告などの記録は残ります）。' : '有効にすると、再びログインできます。'}</span>
              {u.status === 'ACTIVE' ? (
                <button
                  type="button"
                  className="ix-btn danger"
                  disabled={busy || self}
                  title={self ? '自分自身は無効にできません' : undefined}
                  onClick={() => void run('POST', `/users/${u.id}/deactivate`, { expectedVersion: u.version, ...(reason.trim() !== '' ? { reason: reason.trim() } : {}) }, '無効にしました。')}
                >
                  無効にする
                </button>
              ) : (
                <button type="button" className="ix-btn primary" disabled={busy} onClick={() => void run('POST', `/users/${u.id}/activate`, { expectedVersion: u.version, ...(reason.trim() !== '' ? { reason: reason.trim() } : {}) }, '有効にしました。')}>
                  有効にする
                </button>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
