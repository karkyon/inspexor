// 開発用の現場（FIELD）・事務（OFFICE）ユーザーを作成する（APP_ENV=local/dev限定、既存なら何もしない）。
// G3 E2E（現場入力）と SCR-13 の参照のみ確認に使う。パスワードは画面に出さず、それぞれ権限600のファイルに保存する。
//   ~/.inspexor-dev-field-password / ~/.inspexor-dev-office-password
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import pg from 'pg';

const USERS = [
  { loginId: 'dev-field', displayName: '開発用現場', role: 'FIELD', file: '.inspexor-dev-field-password' },
  { loginId: 'dev-office', displayName: '開発用事務', role: 'OFFICE', file: '.inspexor-dev-office-password' },
];

if (!['local', 'dev'].includes(process.env.APP_ENV ?? '')) {
  console.error(`APP_ENV=${process.env.APP_ENV ?? '(未設定)'} のため中止しました（local/devのみ許可）。`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が未設定です。');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const u of USERS) {
    const path = join(homedir(), u.file);
    const existing = await client.query('SELECT id FROM app.users WHERE login_id = $1', [u.loginId]);
    if (existing.rowCount > 0) {
      if (!existsSync(path)) {
        console.error(`ユーザー ${u.loginId} は存在しますが ${path} がありません（パスワード不明）。`);
        process.exitCode = 1;
      } else {
        console.log(`ユーザー ${u.loginId}（${u.role}）は既に存在します（変更なし）。`);
      }
      continue;
    }
    const password = existsSync(path) ? readFileSync(path, 'utf8').trim() : randomBytes(18).toString('base64url');
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO app.users (login_id, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id', [u.loginId, hash, u.displayName]);
    await client.query('INSERT INTO app.user_roles (user_id, role) VALUES ($1, $2)', [inserted.rows[0].id, u.role]);
    await client.query('COMMIT');
    writeFileSync(path, password + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`ユーザー ${u.loginId}（${u.role}）を作成しました。パスワードは ${path} に保存しました。`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('seed失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
