// CHG-006 g20: 開発用 Firestore への実接続確認（読込・transaction・ログインと同じ照合）。秘密情報は表示しない。
// 実行: FIRESTORE_PROJECT_ID=... npx tsx scripts/firestore-smoke.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { login } from '@inspexor/application';
import { DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';
import { Argon2PasswordHasher } from '../lib/auth/argon2-password-hasher';

const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('FIRESTORE_PROJECT_ID が未設定です。');
  process.exit(1);
}
const store = new FirestoreDocStore({ projectId });
let failed = false;
try {
  const t0 = Date.now();
  await store.get('_health/ping');
  console.log(`読込 OK（${Date.now() - t0}ms）`);
  const repo = new DocUserRepository(store);
  for (const [loginId, file] of [
    ['dev-admin', '.inspexor-dev-admin-password'],
    ['dev-field', '.inspexor-dev-field-password'],
    ['dev-office', '.inspexor-dev-office-password'],
  ] as const) {
    const password = readFileSync(join(homedir(), file), 'utf8').trim();
    const ok = await login({ loginId, password }, { userRepository: repo, passwordHasher: new Argon2PasswordHasher(), now: new Date() });
    const bad = await login({ loginId, password: `${password}x` }, { userRepository: repo, passwordHasher: new Argon2PasswordHasher(), now: new Date() });
    // 誤パスワードで増えた失敗回数を成功ログインで 0 に戻す
    const reset = await login({ loginId, password }, { userRepository: repo, passwordHasher: new Argon2PasswordHasher(), now: new Date() });
    const pass = ok.ok && !bad.ok && reset.ok;
    failed ||= !pass;
    console.log(`ログイン照合 ${loginId}: ${pass ? 'OK' : 'NG'}（正しいパスワード=${ok.ok ? '成功' : '失敗'}、誤り=${bad.ok ? '成功' : '拒否'}）`);
  }
} catch (err) {
  failed = true;
  console.error('Firestore 接続失敗:', err instanceof Error ? err.message : err);
} finally {
  await store.close();
}
process.exitCode = failed ? 1 : 0;
