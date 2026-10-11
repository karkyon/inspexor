// CHG-006: 実 Firestore で、アプリが使う検索がすべて実行できるか（複合索引が作成済みか）を確認する。
// 索引の作成直後は「作成中」で失敗するため、最大10分待つ。データは書き込まない。
// 実行: FIRESTORE_PROJECT_ID=... npx tsx scripts/firestore-index-check.ts
import { FirestoreDocStore, isDocStoreError, type QuerySpec } from '@inspexor/docstore';
import { FieldReportService } from '../lib/field/field-report-service';

const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('FIRESTORE_PROJECT_ID が未設定です。');
  process.exit(1);
}
const store = new FirestoreDocStore({ projectId });
const svc = new FieldReportService(store);
const DUMMY = '00000000-0000-4000-8000-000000000000';
const office = { userId: DUMMY, roles: ['OFFICE'] };
const field = { userId: DUMMY, roles: ['FIELD'] };
const base = { page: 1, pageSize: 10, status: null, dateFrom: null, dateTo: null };
const month = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };

const checks: Array<[string, () => Promise<unknown>]> = [
  ['一覧（事務所・条件なし）', () => svc.list(office, base)],
  ['一覧（事務所・期間）', () => svc.list(office, { ...base, ...month })],
  ['一覧（現場・本人）', () => svc.list(field, base)],
  ['一覧（現場・本人・期間）', () => svc.list(field, { ...base, ...month })],
  ['一覧（品番・期間）', () => svc.list(office, { ...base, ...month, productId: DUMMY })],
  ['一覧（お客様・期間）', () => svc.list(office, { ...base, ...month, customerId: DUMMY })],
  ['一覧（状態・期間）', () => svc.list(office, { ...base, ...month, status: 'CONFIRMED' })],
  ['一覧（お客様＋品番・期間）', () => svc.list(office, { ...base, ...month, customerId: DUMMY, productId: DUMMY })],
  ['一覧（現場・状態）', () => svc.list(field, { ...base, status: 'DRAFT' })],
  ...(['workReports', 'deliveryReports'] as const).map(
    (c): [string, () => Promise<unknown>] => [
      `月次（${c}）`,
      () => store.query(c, { where: [{ field: 'current.businessDate', op: '>=', value: '2026-10-01' }, { field: 'current.businessDate', op: '<=', value: '2026-10-31' }] } satisfies QuerySpec),
    ],
  ),
];

let failed = false;
try {
  for (const [label, run] of checks) {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      try {
        await run();
        console.log(`OK  ${label}`);
        break;
      } catch (error) {
        const building = isDocStoreError(error, 'INDEX_REQUIRED') || /index/i.test(error instanceof Error ? error.message : '');
        if (building && Date.now() < deadline) {
          console.log(`..  ${label}: 索引の作成待ち（20秒後に再試行）`);
          await new Promise((r) => setTimeout(r, 20_000));
          continue;
        }
        failed = true;
        console.error(`NG  ${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        break;
      }
    }
  }
} finally {
  await store.close();
}
process.exitCode = failed ? 1 : 0;
