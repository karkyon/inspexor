// CHG-013 マスタ・利用者の一括登録（Excel → Firestore）。画面と同じ規則（MasterService）で登録・更新し、監査に残す。
//   確認だけ（既定。書き込まない）:  FIRESTORE_PROJECT_ID=... npx tsx scripts/import-masters.ts <ファイル.xlsx> --actor <管理者のログインID>
//   登録する:                       … --apply --reason "初期登録"（既存の行を更新するときの理由。既定「一括登録」）
//   利用者を追加したときは、初期パスワードを権限600のファイルに書き出す（既定 ~/inspexor-initial-passwords-<日時>.csv）。画面には出さない
//   APP_ENV=prod のときは --apply に加えて --prod を付ける（本番への書き込みの確認）
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import { DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';
import { importWorkbook, type RowResult } from '../lib/import/master-import';
import { readWorkbook } from '../lib/import/xlsx';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a) => a.endsWith('.xlsx'));
const apply = args.includes('--apply');
const actorLogin = opt('--actor');
const reason = opt('--reason') ?? '一括登録';
const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!file || !actorLogin || !projectId) {
  console.error('使い方: FIRESTORE_PROJECT_ID=... npx tsx scripts/import-masters.ts <ファイル.xlsx> --actor <管理者のログインID> [--apply] [--reason 理由] [--passwords-out ファイル]');
  process.exit(1);
}
if (apply && process.env['APP_ENV'] === 'prod' && !args.includes('--prod')) {
  console.error('本番（APP_ENV=prod）へ書き込むには --prod も付けてください。中止しました。');
  process.exit(1);
}

const LABEL: Record<RowResult['action'], string> = { create: '追加', update: '更新', same: '変更なし', error: 'エラー' };
const store = new FirestoreDocStore({ projectId });
try {
  const actor = await new DocUserRepository(store).findByLoginId(actorLogin);
  if (actor === null || !actor.roles.includes('ADMIN')) throw new Error(`管理者のログインID「${actorLogin}」が見つかりません（監査の実行者として使います）。`);
  const book = await readWorkbook(readFileSync(file));
  const result = await importWorkbook(store, book, { apply, actorId: actor.id, reason, now: new Date(), hashPassword: (p) => argon2.hash(p, { type: argon2.argon2id }) });
  for (const r of result.rows.filter((x) => x.action !== 'same')) {
    console.log(`${r.sheet} ${r.row}行目 ${r.key}: ${LABEL[r.action]}${r.messages.length > 0 ? ` — ${r.messages.join(' / ')}` : ''}`);
  }
  console.log(`合計: 追加 ${result.counts.create} / 更新 ${result.counts.update} / 変更なし ${result.counts.same} / エラー ${result.counts.error}`);
  if (result.counts.error > 0) {
    console.log('エラーがあるため登録していません。Excel を直してからもう一度実行してください。');
    process.exitCode = 1;
  } else if (!result.applied) {
    console.log('確認のみ（書き込んでいません）。登録するには --apply を付けて実行してください。');
  } else {
    console.log('登録しました。');
    if (result.passwords.length > 0) {
      const out = opt('--passwords-out') ?? join(homedir(), `inspexor-initial-passwords-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`);
      const csv = '﻿ログインID,表示名,区分,初期パスワード\r\n' + result.passwords.map((p) => [p.loginId, p.displayName, p.roles, p.password].map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
      writeFileSync(out, csv, { mode: 0o600 });
      chmodSync(out, 0o600);
      console.log(`利用者 ${result.passwords.length} 人の初期パスワードを ${out} に保存しました（権限600。本人に別の方法で伝えたら削除してください）。`);
    }
  }
} catch (err) {
  console.error('取込に失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
