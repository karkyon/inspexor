// CHG-012 運用: 管理者の多要素認証を解除する（認証アプリの端末を失くし、回復コードもなく、他に管理者がいないとき）。
// 次のログインで登録し直す。それより前の session は使えなくなる。監査に残す（実行者は運用担当: actorId なし）。
// 実行: FIRESTORE_PROJECT_ID=... npx tsx scripts/reset-mfa.ts <ログインID> [理由]
//   開発: npx tsx --env-file=apps/web/.env.local apps/web/scripts/reset-mfa.ts dev-admin "E2E の秘密鍵の作り直し"
import { randomUUID } from 'node:crypto';
import { appendAudit, C, DocUserRepository, FirestoreDocStore, type UserDoc } from '@inspexor/docstore';

const projectId = process.env['FIRESTORE_PROJECT_ID'];
const loginId = process.argv[2];
const reason = process.argv[3] ?? '運用担当による解除';
if (!projectId || !loginId) {
  console.error('使い方: FIRESTORE_PROJECT_ID=... npx tsx scripts/reset-mfa.ts <ログインID> [理由]');
  process.exit(1);
}

const store = new FirestoreDocStore({ projectId });
try {
  const user = await new DocUserRepository(store).findByLoginId(loginId);
  if (user === null) {
    console.error(`利用者 ${loginId} が見つかりません。`);
    process.exitCode = 1;
  } else {
    const changed = await store.runTransaction(async (tx) => {
      const path = `${C.users}/${user.id}`;
      const u = await tx.get<UserDoc>(path);
      if (u === null || (u.mfa ?? null) === null) return false;
      const now = new Date();
      tx.update(path, { mfa: null, authChangedAt: now, version: u.version + 1, updatedAt: now });
      appendAudit(tx, { actorId: null, action: 'USER_RESET_MFA', targetType: 'USER', targetId: user.id, beforeData: { mfaEnabled: true }, afterData: { mfaEnabled: false, by: 'operator-script' }, reason, correlationId: randomUUID(), occurredAt: now }, now);
      return true;
    });
    console.log(changed ? `${loginId} の多要素認証を解除しました。次のログインで登録し直します。` : `${loginId} は多要素認証を登録していません（変更なし）。`);
  }
} catch (err) {
  console.error('解除に失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
