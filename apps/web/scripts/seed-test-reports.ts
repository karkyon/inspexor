// CHG-013 試験用の作業日報・運搬実績を期間指定で作り、確定する（帳票は worker が作る）。
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/seed-test-reports.ts --from 2026-12-01 --to 2026-12-15 --customers TEST-C01,TEST-C02 --reporter test.field01
//     [--work-per-day 3] [--delivery-per-day 1] [--seed 1] [--draft]（--draft は確定しない）[--master-prefix TEST-]
//   本番（APP_ENV=prod）では --prod が必要で、お客様コードが TEST- で始まるものだけ使える（実データと混ざらないように）
import { DocUserRepository, FirestoreDocStore } from '@inspexor/docstore';
import { generateTestReports } from '../lib/import/test-reports';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectId = process.env['FIRESTORE_PROJECT_ID'];
const from = opt('--from');
const to = opt('--to');
const customers = (opt('--customers') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const reporterLogin = opt('--reporter');
if (!projectId || !from || !to || customers.length === 0 || !reporterLogin) {
  console.error('使い方: FIRESTORE_PROJECT_ID=... npx tsx scripts/seed-test-reports.ts --from YYYY-MM-DD --to YYYY-MM-DD --customers TEST-C01[,…] --reporter <現場のログインID> [--work-per-day 3] [--delivery-per-day 1] [--seed N] [--draft]');
  process.exit(1);
}
if (process.env['APP_ENV'] === 'prod') {
  if (!args.includes('--prod')) {
    console.error('本番（APP_ENV=prod）へ書き込むには --prod も付けてください。中止しました。');
    process.exit(1);
  }
  if (customers.some((c) => !c.startsWith('TEST-'))) {
    console.error('本番では、お客様コードが TEST- で始まるお客様だけに試験データを作れます。中止しました。');
    process.exit(1);
  }
}

const store = new FirestoreDocStore({ projectId });
try {
  const reporter = await new DocUserRepository(store).findByLoginId(reporterLogin);
  if (reporter === null || reporter.status !== 'ACTIVE' || !reporter.roles.includes('FIELD')) throw new Error(`報告者「${reporterLogin}」は有効な現場の利用者ではありません。`);
  const r = await generateTestReports(store, {
    from,
    to,
    customerCodes: customers,
    reporterId: reporter.id,
    workPerDay: Number(opt('--work-per-day') ?? 3),
    deliveryPerDay: Number(opt('--delivery-per-day') ?? 1),
    seed: Number(opt('--seed') ?? 20261016),
    confirm: !args.includes('--draft'),
    masterPrefix: opt('--master-prefix') ?? (customers.every((c) => c.startsWith('TEST-')) ? 'TEST-' : ''),
  });
  console.log(`作成しました: 作業日報 ${r.work} 件・運搬実績 ${r.delivery} 件（${r.days} 日分）。報告番号 ${r.reportNos[0] ?? ''} 〜 ${r.reportNos[r.reportNos.length - 1] ?? ''}`);
  console.log('帳票（PDF）は worker が順に作ります（開発: 起動中の worker、本番: 確定直後の起動と15分ごとの起動）。');
} catch (err) {
  console.error('作成に失敗:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await store.close();
}
