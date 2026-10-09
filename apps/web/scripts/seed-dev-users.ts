// 開発用ユーザー（ADMIN / FIELD / OFFICE）を Firestore に作成する（CHG-006。APP_ENV=local/dev 限定、既存なら何もしない）。
// パスワードは画面に出さず、それぞれ権限600のファイルに保存する（既にファイルがあればその値を使う）。
//   ~/.inspexor-dev-admin-password / ~/.inspexor-dev-field-password / ~/.inspexor-dev-office-password
// 実行: FIRESTORE_PROJECT_ID=... APP_ENV=dev npx tsx scripts/seed-dev-users.ts
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { createUser, DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';

const USERS = [
  { loginId: 'dev-admin', displayName: '開発用管理者', role: 'ADMIN', file: '.inspexor-dev-admin-password' },
  { loginId: 'dev-field', displayName: '開発用現場', role: 'FIELD', file: '.inspexor-dev-field-password' },
  { loginId: 'dev-office', displayName: '開発用事務', role: 'OFFICE', file: '.inspexor-dev-office-password' },
] as const;

const appEnv = process.env['APP_ENV'] ?? '';
if (!['local', 'dev'].includes(appEnv)) {
  console.error(`APP_ENV=${appEnv || '(未設定)'} のため中止しました（local/dev のみ許可）。`);
  process.exit(1);
}
const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('FIRESTORE_PROJECT_ID が未設定です。');
  process.exit(1);
}

const store = new FirestoreDocStore({ projectId });
const repo = new DocUserRepository(store);
try {
  for (const u of USERS) {
    const path = join(homedir(), u.file);
    const existing = await repo.findByLoginId(u.loginId);
    if (existing !== null) {
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
    const id = await createUser(store, { loginId: u.loginId, passwordHash: hash, displayName: u.displayName, roles: [u.role] }, new Date());
    if (id === null) {
      console.log(`ユーザー ${u.loginId} は同時に作成されました（変更なし）。`);
      continue;
    }
    if (!existsSync(path)) {
      writeFileSync(path, password + '\n', { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    console.log(`ユーザー ${u.loginId}（${u.role}）を作成しました。パスワードは ${path} にあります。`);
  }
} catch (err) {
  console.error('seed失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
