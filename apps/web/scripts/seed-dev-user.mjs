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
