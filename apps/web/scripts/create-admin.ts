// 本番の初期管理者（ADMIN）を Firestore に作成する（CHG-006 g25。既にあれば何もしない）。
// パスワードは画面に出さず、権限600のファイルに保存する（既にファイルがあればその値を使う）。
//   ADMIN_LOGIN_ID（既定 admin）/ ADMIN_PASSWORD_FILE（既定 ~/.inspexor-prod-admin-password）
// 実行: APP_ENV=prod FIRESTORE_PROJECT_ID=... npx tsx scripts/create-admin.ts
// 開発用の合成データ（seed-dev-users / seed-masters）は本番に入れない。
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { createUser, DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';

const appEnv = process.env['APP_ENV'] ?? '';
const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!['stg', 'prod'].includes(appEnv) || !projectId) {
  console.error('APP_ENV=stg|prod と FIRESTORE_PROJECT_ID を指定してください。中止しました。');
  process.exit(1);
}
const loginId = process.env['ADMIN_LOGIN_ID'] ?? 'admin';
const file = process.env['ADMIN_PASSWORD_FILE'] ?? join(homedir(), '.inspexor-prod-admin-password');

const store = new FirestoreDocStore({ projectId });
try {
  const existing = await new DocUserRepository(store).findByLoginId(loginId);
  if (existing !== null) {
    console.log(`管理者 ${loginId} は既に存在します（変更なし）。${existsSync(file) ? `パスワードは ${file} にあります。` : `${file} がありません（パスワード不明）。`}`);
    if (!existsSync(file)) process.exitCode = 1;
  } else {
    const password = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(18).toString('base64url');
    if (password.length < 12) throw new Error(`${file} のパスワードが短すぎます（12文字以上）`);
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const id = await createUser(store, { loginId, passwordHash: hash, displayName: '管理者', roles: ['ADMIN'] }, new Date());
    if (!existsSync(file)) {
      writeFileSync(file, password + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    console.log(id === null ? `管理者 ${loginId} は同時に作成されました（変更なし）。` : `管理者 ${loginId} を作成しました。パスワードは ${file} にあります。`);
  }
} catch (err) {
  console.error('管理者の作成に失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
