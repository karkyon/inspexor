#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

mkdir -p apps/web/lib/auth apps/web/components apps/web/app/login

# ============================================================
# 1. apps/web/lib/auth/login-response.ts + test
#    （サンドボックスで11/11 PASS確認済み: login-response/me-response 計11件）
# ============================================================
cat > apps/web/lib/auth/login-response.ts << 'EOF'
export interface LoginSuccessData {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly csrfToken: string;
}

export type LoginOutcome =
  | { readonly kind: 'success'; readonly data: LoginSuccessData }
  | { readonly kind: 'error'; readonly message: string };

function isSuccessBody(value: unknown): value is { data: LoginSuccessData } {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    return false;
  }
  const data = (value as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['roles']) &&
    typeof candidate['csrfToken'] === 'string'
  );
}

function isErrorBody(value: unknown): value is { error: { code: string } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['code'] === 'string';
}

function loginErrorMessage(code: string, status: number): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'ログインIDまたはパスワードが正しくありません。';
    case 'ACCOUNT_LOCKED':
      return 'アカウントがロックされています。しばらく時間をおいてから再度お試しください。';
    case 'VALIDATION_ERROR':
      return '入力内容を確認してください。';
    case 'RATE_LIMITED':
      return 'しばらく時間をおいてから再度お試しください。';
    default:
      return `エラーが発生しました（${status}）。`;
  }
}

export function interpretLoginResponse(status: number, body: unknown): LoginOutcome {
  if (status === 200 && isSuccessBody(body)) {
    return { kind: 'success', data: body.data };
  }
  if (isErrorBody(body)) {
    return { kind: 'error', message: loginErrorMessage(body.error.code, status) };
  }
  return { kind: 'error', message: '予期しないエラーが発生しました。しばらくしてから再度お試しください。' };
}
EOF

cat > apps/web/lib/auth/login-response.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { interpretLoginResponse } from './login-response';

describe('interpretLoginResponse', () => {
  it('200 + 正しいdataはsuccessを返す', () => {
    const body = { data: { userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'], csrfToken: 'tok' } };
    const outcome = interpretLoginResponse(200, body);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.data.displayName).toBe('田中太郎');
    }
  });

  it('401 AUTH_REQUIREDは専用メッセージ', () => {
    const outcome = interpretLoginResponse(401, { error: { code: 'AUTH_REQUIRED' } });
    expect(outcome).toEqual({ kind: 'error', message: 'ログインIDまたはパスワードが正しくありません。' });
  });

  it('423 ACCOUNT_LOCKEDは専用メッセージ', () => {
    const outcome = interpretLoginResponse(423, { error: { code: 'ACCOUNT_LOCKED' } });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('ロック');
    }
  });

  it('422 VALIDATION_ERRORは専用メッセージ', () => {
    const outcome = interpretLoginResponse(422, { error: { code: 'VALIDATION_ERROR' } });
    expect(outcome.kind).toBe('error');
  });

  it('未知のエラーコードはステータス付き汎用メッセージ', () => {
    const outcome = interpretLoginResponse(500, { error: { code: 'INTERNAL_ERROR' } });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('500');
    }
  });

  it('bodyが壊れている場合は汎用メッセージ（例外を投げない）', () => {
    expect(() => interpretLoginResponse(500, null)).not.toThrow();
    expect(() => interpretLoginResponse(200, 'not-json-shape')).not.toThrow();
    const outcome = interpretLoginResponse(200, {});
    expect(outcome.kind).toBe('error');
  });

  it('200だがdata形状が不正ならerror扱い', () => {
    const outcome = interpretLoginResponse(200, { data: { userId: 123 } });
    expect(outcome.kind).toBe('error');
  });
});
EOF

# ============================================================
# 2. apps/web/lib/auth/me-response.ts + test
# ============================================================
cat > apps/web/lib/auth/me-response.ts << 'EOF'
export interface MeData {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export type MeOutcome =
  | { readonly kind: 'authenticated'; readonly data: MeData }
  | { readonly kind: 'unauthenticated' };

function isMeDataBody(value: unknown): value is { data: MeData } {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    return false;
  }
  const data = (value as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['roles'])
  );
}

export function interpretMeResponse(status: number, body: unknown): MeOutcome {
  if (status === 200 && isMeDataBody(body)) {
    return { kind: 'authenticated', data: body.data };
  }
  return { kind: 'unauthenticated' };
}
EOF

cat > apps/web/lib/auth/me-response.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { interpretMeResponse } from './me-response';

describe('interpretMeResponse', () => {
  it('200 + 正しいdataはauthenticatedを返す', () => {
    const outcome = interpretMeResponse(200, {
      data: { userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'] },
    });
    expect(outcome.kind).toBe('authenticated');
  });

  it('401はunauthenticatedを返す', () => {
    const outcome = interpretMeResponse(401, { error: { code: 'AUTH_REQUIRED' } });
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  it('200だがdata形状不正はunauthenticated扱い（例外なし）', () => {
    expect(() => interpretMeResponse(200, {})).not.toThrow();
    expect(interpretMeResponse(200, {}).kind).toBe('unauthenticated');
  });

  it('bodyがnullでも例外を投げない', () => {
    expect(() => interpretMeResponse(500, null)).not.toThrow();
  });
});
EOF

# ============================================================
# 3. apps/web/components/LoginForm.tsx
# ============================================================
cat > apps/web/components/LoginForm.tsx << 'EOF'
'use client';

import { useState, type FormEvent } from 'react';
import { interpretLoginResponse, type LoginSuccessData } from '../lib/auth/login-response';

export const CSRF_TOKEN_STORAGE_KEY = 'inspexor_csrf_token';

export interface LoginFormProps {
  readonly onLoginSuccess: (data: LoginSuccessData) => void;
}

export function LoginForm({ onLoginSuccess }: LoginFormProps) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password }),
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = interpretLoginResponse(response.status, body);

      if (outcome.kind === 'success') {
        try {
          window.sessionStorage.setItem(CSRF_TOKEN_STORAGE_KEY, outcome.data.csrfToken);
        } catch {
          // sessionStorageが使えない環境でもログイン自体は継続する
        }
        onLoginSuccess(outcome.data);
      } else {
        setErrorMessage(outcome.message);
      }
    } catch {
      setErrorMessage('通信エラーが発生しました。ネットワーク状態を確認してください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <label htmlFor="loginId" style={{ display: 'block', marginBottom: 4 }}>
          ログインID
        </label>
        <input
          id="loginId"
          name="loginId"
          type="text"
          autoComplete="username"
          required
          value={loginId}
          onChange={(event) => setLoginId(event.target.value)}
          style={{ width: '100%', padding: 8 }}
        />
      </div>
      <div>
        <label htmlFor="password" style={{ display: 'block', marginBottom: 4 }}>
          パスワード
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ width: '100%', padding: 8 }}
        />
      </div>
      {errorMessage !== null ? (
        <p role="alert" style={{ color: '#b00020', margin: 0 }}>
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" disabled={submitting} style={{ padding: 10 }}>
        {submitting ? 'ログイン中…' : 'ログイン'}
      </button>
    </form>
  );
}
EOF

# ============================================================
# 4. apps/web/components/LogoutButton.tsx
# ============================================================
cat > apps/web/components/LogoutButton.tsx << 'EOF'
'use client';

import { useState } from 'react';
import { CSRF_TOKEN_STORAGE_KEY } from './LoginForm';

export interface LogoutButtonProps {
  readonly onLoggedOut: () => void;
}

export function LogoutButton({ onLoggedOut }: LogoutButtonProps) {
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
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: csrfToken !== null ? { 'X-CSRF-Token': csrfToken } : {},
      });
      if (response.status === 204) {
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
      <button type="button" onClick={handleClick} disabled={submitting} style={{ padding: 8 }}>
        {submitting ? 'ログアウト中…' : 'ログアウト'}
      </button>
      {errorMessage !== null ? (
        <p role="alert" style={{ color: '#b00020' }}>
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
EOF

# ============================================================
# 5. apps/web/components/HomeClient.tsx（ルート画面本体）
# ============================================================
cat > apps/web/components/HomeClient.tsx << 'EOF'
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
        const response = await fetch('/api/me');
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
EOF

# ============================================================
# 6. apps/web/components/LoginPageClient.tsx（/login画面本体、成功時は'/'へ遷移）
#    注: next/navigationのuseRouterはサンドボックスにnext未導入のため
#    型チェックはできていない（Next.js公式の標準的な使い方のみ使用）。
# ============================================================
cat > apps/web/components/LoginPageClient.tsx << 'EOF'
'use client';

import { useRouter } from 'next/navigation';
import { LoginForm } from './LoginForm';

export function LoginPageClient() {
  const router = useRouter();

  return (
    <div>
      <h1>INSPEXOR ログイン</h1>
      <LoginForm
        onLoginSuccess={() => {
          router.push('/');
        }}
      />
    </div>
  );
}
EOF

# ============================================================
# 7. apps/web/app/page.tsx（ルートページを置き換え）
# ============================================================
cat > apps/web/app/page.tsx << 'EOF'
import { HomeClient } from '../components/HomeClient';

export default function HomePage() {
  return (
    <main style={{ padding: 24 }}>
      <h1>INSPEXOR</h1>
      <HomeClient />
    </main>
  );
}
EOF

# ============================================================
# 8. apps/web/app/login/page.tsx（新規）
# ============================================================
cat > apps/web/app/login/page.tsx << 'EOF'
import { LoginPageClient } from '../../components/LoginPageClient';

export default function LoginPage() {
  return (
    <main style={{ padding: 24 }}>
      <LoginPageClient />
    </main>
  );
}
EOF

# ============================================================
# 9. apps/web/tsconfig.json の include/files に新規ファイルを自動追記
#    （g0_fix3.shと同一ロジック）
# ============================================================
node << 'NODEEOF'
const fs = require('fs');
const path = require('path');

const tsconfigPath = path.join('apps/web', 'tsconfig.json');
const raw = fs.readFileSync(tsconfigPath, 'utf8');
const config = JSON.parse(raw);

function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
}

const found = [];
for (const base of ['app', 'lib', 'components']) {
  const baseDir = path.join('apps/web', base);
  if (fs.existsSync(baseDir)) {
    walk(baseDir, found);
  }
}
const relativeToApp = found.map((p) => path.relative('apps/web', p).split(path.sep).join('/'));

function patchLiteralArray(key) {
  if (!Array.isArray(config[key])) {
    return false;
  }
  const hasGlob = config[key].some((entry) => typeof entry === 'string' && entry.includes('*'));
  if (hasGlob) {
    console.log(`apps/web/tsconfig.json の "${key}" はglobパターンを含むため変更不要。`);
    return false;
  }
  const existing = new Set(config[key]);
  let added = 0;
  for (const rel of relativeToApp) {
    if (!existing.has(rel)) {
      config[key].push(rel);
      existing.add(rel);
      added += 1;
    }
  }
  config[key].sort();
  console.log(`apps/web/tsconfig.json の "${key}" に ${added} 件追加しました。`);
  return added > 0;
}

let changed = false;
changed = patchLiteralArray('files') || changed;
changed = patchLiteralArray('include') || changed;

if (!changed) {
  console.log('変更対象が見つかりませんでした。');
}

fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
NODEEOF

# ============================================================
# 10. 検証
# ============================================================
echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit)

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
