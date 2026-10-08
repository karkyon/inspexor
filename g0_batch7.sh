#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor
W=apps/web

# ============================================================
# 1. API path を openapi準拠の /api/v1 に移設（API設計書: base `/api/v1`、API-003は `GET /me`）
#    旧 /api/auth/{login,logout,me} は削除。/api/health はインフラ用のため据え置き。
# ============================================================
mkdir -p $W/app/api/v1/auth/login $W/app/api/v1/auth/logout $W/app/api/v1/me

cat > $W/app/api/v1/auth/login/route.ts << 'EOF'
import { PrismaUserRepository } from '../../../../../lib/auth/prisma-user-repository';
import { Argon2PasswordHasher } from '../../../../../lib/auth/argon2-password-hasher';
import { handleLoginRequest } from '../../../../../lib/auth/login-handler';
import { prisma } from '../../../../../lib/db/prisma-client';
import { getSessionSecret } from '../../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request, {
    userRepository: new PrismaUserRepository(prisma),
    passwordHasher: new Argon2PasswordHasher(),
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

cat > $W/app/api/v1/auth/logout/route.ts << 'EOF'
import { handleLogoutRequest } from '../../../../../lib/auth/logout-handler';
import { getSessionSecret } from '../../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLogoutRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

cat > $W/app/api/v1/me/route.ts << 'EOF'
import { handleMeRequest } from '../../../../lib/auth/me-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function GET(request: Request): Promise<Response> {
  return handleMeRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

rm -rf $W/app/api/auth

# ============================================================
# 2. クライアント側の呼び先を /api/v1 に変更
# ============================================================
sed -i "s#fetch('/api/auth/login'#fetch('/api/v1/auth/login'#" $W/components/LoginForm.tsx
sed -i "s#fetch('/api/auth/logout'#fetch('/api/v1/auth/logout'#" $W/components/LogoutButton.tsx
sed -i "s#fetch('/api/me')#fetch('/api/v1/me')#" $W/components/HomeClient.tsx
echo "=== fetch先確認 ==="
grep -n "fetch(" $W/components/*.tsx

# ============================================================
# 3. apps/web/tsconfig.json 補正（include追記＋消えたパス除去＋lib に DOM 追加）
# ============================================================
mkdir -p $W/scripts
cat > $W/scripts/patch-tsconfig.cjs << 'EOF'
// apps/web/tsconfig.json 補正:
//  (1) app/lib/components/scripts 配下の .ts/.tsx を "include" にリテラル追記（glob有無に関係なく）
//  (2) 実在しないリテラルパスを "include" から除去（ルート移設で消えたファイル対策）
//  (3) compilerOptions.lib に DOM / DOM.Iterable を追加（extends 連鎖から既存libを継承した上で）
const fs = require('fs');
const path = require('path');

const appDir = process.argv[2] || 'apps/web';
const tsconfigPath = path.join(appDir, 'tsconfig.json');
const config = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

function readJsonLoose(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1'));
  }
}

function resolveInheritedLib(cfg, baseDir) {
  if (cfg.compilerOptions && Array.isArray(cfg.compilerOptions.lib)) {
    return cfg.compilerOptions.lib;
  }
  if (typeof cfg.extends !== 'string') {
    return null;
  }
  let parentPath = path.resolve(baseDir, cfg.extends);
  if (!parentPath.endsWith('.json')) {
    parentPath += '.json';
  }
  if (!fs.existsSync(parentPath)) {
    console.log(`extends先 ${cfg.extends} が見つかりません（lib継承の解決をスキップ）`);
    return null;
  }
  return resolveInheritedLib(readJsonLoose(parentPath), path.dirname(parentPath));
}

// ---- (1)(2) include ----
function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) results.push(full);
  }
}
const found = [];
for (const base of ['app', 'lib', 'components']) {
  const d = path.join(appDir, base);
  if (fs.existsSync(d)) walk(d, found);
}
const rel = found.map((p) => path.relative(appDir, p).split(path.sep).join('/'));

if (!Array.isArray(config.include)) config.include = [];
const before = config.include.length;
config.include = config.include.filter(
  (e) => typeof e !== 'string' || e.includes('*') || e.endsWith('.d.ts') || !/\.(ts|tsx)$/.test(e) || fs.existsSync(path.join(appDir, e)),
);
const removed = before - config.include.length;
const existing = new Set(config.include);
let added = 0;
for (const r of rel) {
  if (!existing.has(r)) {
    config.include.push(r);
    existing.add(r);
    added += 1;
  }
}
config.include.sort();
console.log(`include: 追加 ${added} 件 / 実在しないパス除去 ${removed} 件`);

// ---- (3) lib ----
const inherited = resolveInheritedLib(config, appDir);
const libs = inherited ? [...inherited] : ['ES2022'];
const lower = new Set(libs.map((l) => String(l).toLowerCase()));
for (const l of ['DOM', 'DOM.Iterable']) {
  if (!lower.has(l.toLowerCase())) libs.push(l);
}
config.compilerOptions = config.compilerOptions || {};
config.compilerOptions.lib = libs;
console.log(`compilerOptions.lib = ${JSON.stringify(libs)}（継承元: ${inherited ? JSON.stringify(inherited) : 'なし→ES2022'}）`);

fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
EOF
node $W/scripts/patch-tsconfig.cjs $W

# ============================================================
# 4. 開発用ユーザーseedスクリプト
# ============================================================
cat > $W/scripts/seed-dev-user.mjs << 'EOF'
// 開発用ADMINユーザーを1件だけ作成する（APP_ENV=local/dev限定、既存なら何もしない）。
// パスワードは画面に出さず ~/.inspexor-dev-admin-password（権限600）に保存する。
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import pg from 'pg';

const LOGIN_ID = 'dev-admin';
const DISPLAY_NAME = '開発用管理者';
const PASSWORD_FILE = join(homedir(), '.inspexor-dev-admin-password');

const appEnv = process.env.APP_ENV;
if (appEnv !== 'local' && appEnv !== 'dev') {
  console.error(`APP_ENV=${appEnv ?? '(未設定)'} のためseedを中止しました（local/devのみ許可）。`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が未設定です。');
  process.exit(1);
}

const password = existsSync(PASSWORD_FILE)
  ? readFileSync(PASSWORD_FILE, 'utf8').trim()
  : randomBytes(18).toString('base64url');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT id FROM app.users WHERE login_id = $1', [LOGIN_ID]);
  if (existing.rowCount > 0) {
    console.log(`ユーザー ${LOGIN_ID} は既に存在します（変更なし）。`);
    await client.query('ROLLBACK');
  } else {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await client.query(
      'INSERT INTO app.users (login_id, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
      [LOGIN_ID, hash, DISPLAY_NAME],
    );
    await client.query("INSERT INTO app.user_roles (user_id, role) VALUES ($1, 'ADMIN')", [inserted.rows[0].id]);
    await client.query('COMMIT');
    writeFileSync(PASSWORD_FILE, password + '\n', { mode: 0o600 });
    chmodSync(PASSWORD_FILE, 0o600);
    console.log(`ユーザー ${LOGIN_ID}（ADMIN）を作成しました。パスワードは ${PASSWORD_FILE} に保存しました。`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('seed失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
EOF

# ============================================================
# 5. 検証（tsc / vitest）
# ============================================================
echo "=== apps/web: tsc --noEmit ==="
(cd $W && npx tsc --noEmit) && echo "TSC: PASS"

echo "=== apps/web: vitest run ==="
(cd $W && npx vitest run)

# ============================================================
# 6. seed実行（cloud-sql-proxy起動中であること）
# ============================================================
echo "=== seed: dev-admin ==="
(cd $W && node --env-file=.env.local scripts/seed-dev-user.mjs)

# ============================================================
# 7. スモークテスト（devサーバー稼働中なら実行。パスワードは表示しない）
# ============================================================
if curl -s -o /dev/null -m 5 http://localhost:3000/api/health; then
  echo "=== GET /api/v1/me（未ログイン→401期待） ==="
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/v1/me || true
  echo "=== POST /api/auth/login（旧パス→404期待） ==="
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/login || true
  echo "=== POST /api/v1/auth/login dev-admin（→200期待） ==="
  PW_FILE="$HOME/.inspexor-dev-admin-password" node -e '
    const fs = require("fs");
    const pw = fs.readFileSync(process.env.PW_FILE, "utf8").trim();
    fetch("http://localhost:3000/api/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "dev-admin", password: pw }),
    }).then(async (r) => {
      const b = await r.json().catch(() => null);
      console.log(r.status, b && b.data ? `displayName=${b.data.displayName} roles=${b.data.roles}` : JSON.stringify(b && b.error && b.error.code));
    }).catch((e) => console.log("fetch失敗:", e.message));
  ' || true
else
  echo "devサーバー未起動のためスモークテストをスキップ（pnpm --filter @inspexor/web dev & で起動後に再確認）"
fi
