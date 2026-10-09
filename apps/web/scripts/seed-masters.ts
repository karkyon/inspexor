// EXT-02（実master）未提供時の deterministic synthetic seed（MVP開発計画 §外部入力）。APP_ENV=local/dev 限定。
// CHG-006: Firestore 版。何度実行しても同じ状態になる（既存 code はスキップ）。値はすべて合成値。
//   APP_ENV=dev FIRESTORE_PROJECT_ID=... npx tsx scripts/seed-masters.ts
import { DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';
import { seedMasters } from '../lib/masters/synthetic-seed';

if (!['local', 'dev'].includes(process.env['APP_ENV'] ?? '')) {
  console.error(`APP_ENV=${process.env['APP_ENV'] ?? '(未設定)'} のため中止（local/devのみ）`);
  process.exit(1);
}
const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('FIRESTORE_PROJECT_ID が未設定です。');
  process.exit(1);
}

const store = new FirestoreDocStore({ projectId });
try {
  const admin = await new DocUserRepository(store).findByLoginId('dev-admin');
  if (admin === null) throw new Error('dev-admin がありません。先に scripts/seed-dev-users.ts を実行してください。');
  const created = await seedMasters(store, admin.id, new Date());
  console.log('seed 完了（新規作成）:', Object.keys(created).length === 0 ? 'なし（すべて既存）' : created);
} catch (error) {
  console.error('seed 失敗:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}
