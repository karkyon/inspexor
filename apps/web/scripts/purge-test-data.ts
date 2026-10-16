// CHG-013 試験データの後片付け（お客様コードが TEST- で始まるお客様の報告を削除し、TEST- のマスタを無効化する）。
//   確認だけ（既定）: FIRESTORE_PROJECT_ID=... npx tsx scripts/purge-test-data.ts --actor <管理者のログインID>
//   実行:            … --apply --reason "T5 現場テストの後片付け" [--users test.]（ログインIDが test. で始まる利用者も利用停止）
//   本番（APP_ENV=prod）は --prod も必要。帳票の PDF は消さないため、表示されたキーの一覧ファイルを手順書のコマンドで消す
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';
import { purgeTestData } from '../lib/import/purge-test-data';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectId = process.env['FIRESTORE_PROJECT_ID'];
const actorLogin = opt('--actor');
const apply = args.includes('--apply');
if (!projectId || !actorLogin) {
  console.error('使い方: FIRESTORE_PROJECT_ID=... npx tsx scripts/purge-test-data.ts --actor <管理者のログインID> [--prefix TEST-] [--users test.] [--apply --reason 理由]');
  process.exit(1);
}
if (apply && process.env['APP_ENV'] === 'prod' && !args.includes('--prod')) {
  console.error('本番（APP_ENV=prod）で実行するには --prod も付けてください。中止しました。');
  process.exit(1);
}
const reason = opt('--reason') ?? '';
if (apply && reason.trim() === '') {
  console.error('--apply のときは --reason（理由）が必要です。');
  process.exit(1);
}

const store = new FirestoreDocStore({ projectId });
try {
  const actor = await new DocUserRepository(store).findByLoginId(actorLogin);
  if (actor === null || !actor.roles.includes('ADMIN')) throw new Error(`管理者のログインID「${actorLogin}」が見つかりません。`);
  const r = await purgeTestData(store, { prefix: opt('--prefix') ?? 'TEST-', userPrefix: opt('--users') ?? '', apply, actorId: actor.id, reason, now: new Date() });
  console.log(`対象のお客様: ${r.customers.join(', ') || 'なし'}`);
  console.log(`報告: 作業日報 ${r.reports.work} 件・運搬実績 ${r.reports.delivery} 件（関連を含む文書 ${r.deletedDocs} 件）`);
  console.log(`無効化するマスタ: ${Object.entries(r.deactivated).map(([k, v]) => `${k} ${v}`).join('、') || 'なし'}`);
  console.log(`利用停止する利用者: ${r.users.join(', ') || 'なし'}`);
  if (!r.applied) {
    console.log('確認のみ（何も変えていません）。実行するには --apply --reason "理由" を付けてください。');
  } else {
    console.log('後片付けを実行しました（記録 TEST_DATA_PURGE）。');
    if (r.storageKeys.length > 0) {
      const out = join(homedir(), `inspexor-test-pdf-keys-${new Date().toISOString().slice(0, 10)}.txt`);
      writeFileSync(out, r.storageKeys.join('\n') + '\n', { mode: 0o600 });
      chmodSync(out, 0o600);
      console.log(`帳票の PDF ${r.storageKeys.length} 件の保存先キーを ${out} に書き出しました。手順書のコマンドで消してください。`);
    }
  }
} catch (err) {
  console.error('後片付けに失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
