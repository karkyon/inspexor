/**
 * CHG-013 結合試験: 試験用の業務データの作成（期間・件数・確定・報告番号の月）と、後片付け（削除・無効化・利用停止・記録）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEventsFor, C, createUser, readUniqueOwner, type ReportHeaderDoc, type UserDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { importWorkbook } from './master-import';
import { readWorkbook, writeTemplate } from './xlsx';
import { generateTestReports } from './test-reports';
import { purgeTestData } from './purge-test-data';
import { seedMasters } from '../masters/synthetic-seed';
import { FieldReportService } from '../field/field-report-service';
import { jstToInstant } from '@inspexor/domain';

const NOW = new Date('2026-12-20T00:00:00Z');
let t: TestStore;
let adminId = '';
let fieldId = '';

beforeAll(async () => {
  t = createTestStore('testdata');
  adminId = (await createUser(t.store, { loginId: 'td-admin', passwordHash: 'x', displayName: '管理者', roles: ['ADMIN'] }, NOW)) as string;
  const r = await importWorkbook(t.store, await readWorkbook(await writeTemplate(true)), { apply: true, actorId: adminId, reason: '試験', now: NOW, hashPassword: async () => 'h' });
  expect(r.counts.error).toBe(0);
  fieldId = (await readUniqueOwner(t.store, 'login', '-', 'test.field01')) as string;
  // 実データ側（SYN- のお客様）も入れておき、後片付けで消えないことを確かめる
  await seedMasters(t.store, adminId, NOW);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('CHG-013 試験用の業務データ', () => {
  it('期間内の日曜以外に、1日あたり指定件数の作業日報・運搬実績を作って確定する（報告番号は作業日の月）。seed が同じなら同じ内容', async () => {
    const r = await generateTestReports(t.store, { from: '2026-11-30', to: '2026-12-06', customerCodes: ['TEST-C01', 'TEST-C02'], reporterId: fieldId, workPerDay: 2, deliveryPerDay: 1, seed: 7 });
    // 11/30(月)〜12/6(日): 日曜を除く 6 日
    expect(r).toMatchObject({ days: 6, work: 12, delivery: 6 });
    expect(r.reportNos[0]).toBe('WR-202611-000001');
    expect(r.reportNos.filter((n) => n.startsWith('WR-202612')).length).toBe(10);
    const headers = await t.store.query<ReportHeaderDoc>(C.workReports);
    expect(headers.every((h) => h.data.status === 'CONFIRMED' && h.data.ownerId === fieldId)).toBe(true);
    const deliveries = await t.store.query<ReportHeaderDoc>(C.deliveryReports);
    expect(deliveries).toHaveLength(6);
    // 同じ seed なら同じ内容（別の store で確かめる）
    const t2 = createTestStore('testdata2');
    try {
      const a2 = (await createUser(t2.store, { loginId: 'td-admin', passwordHash: 'x', displayName: '管理者', roles: ['ADMIN'] }, NOW)) as string;
      await importWorkbook(t2.store, await readWorkbook(await writeTemplate(true)), { apply: true, actorId: a2, reason: '試験', now: NOW, hashPassword: async () => 'h' });
      const f2 = (await readUniqueOwner(t2.store, 'login', '-', 'test.field01')) as string;
      await generateTestReports(t2.store, { from: '2026-11-30', to: '2026-12-06', customerCodes: ['TEST-C01', 'TEST-C02'], reporterId: f2, workPerDay: 2, deliveryPerDay: 1, seed: 7 });
      const q = (h: Array<{ data: ReportHeaderDoc }>) => h.map((x) => `${x.data.reportNo}:${x.data.quantity}`).sort();
      expect(q(await t2.store.query<ReportHeaderDoc>(C.workReports))).toEqual(q(headers));
    } finally {
      await t2.close();
    }
  });

  it('お客様コードが無い・期間が逆・作業者が無いときはエラー', async () => {
    await expect(generateTestReports(t.store, { from: '2026-12-01', to: '2026-12-02', customerCodes: ['NOPE'], reporterId: fieldId })).rejects.toThrow('お客様コード「NOPE」がありません');
    await expect(generateTestReports(t.store, { from: '2026-12-05', to: '2026-12-01', customerCodes: ['TEST-C01'], reporterId: fieldId })).rejects.toThrow('from ≦ to');
    await expect(generateTestReports(t.store, { from: '2026-12-01', to: '2026-12-01', customerCodes: ['TEST-C01'], reporterId: fieldId, masterPrefix: 'NOTHING-' })).rejects.toThrow('有効な作業者がありません');
  });

  it('後片付け: 確認では何も変えない → 実行で TEST- の報告を削除、TEST- のマスタを無効化、test. の利用者を利用停止、実データ（SYN-）と監査は残る', async () => {
    // 実データ側の報告（SYN- のお客様）
    const synCustomer = (await readUniqueOwner(t.store, 'master:customers', '-', 'SYN-C01')) as string;
    const synProduct = (await readUniqueOwner(t.store, 'master:products', synCustomer, 'SYN-P01')) as string;
    const synWt = (await readUniqueOwner(t.store, 'master:work-types', synProduct, 'INSP')) as string;
    const synWorker = (await readUniqueOwner(t.store, 'master:workers', '-', 'SYN-W01')) as string;
    const svc = new FieldReportService(t.store);
    const ctx = { actor: { userId: fieldId, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000001', now: NOW };
    const keep = await svc.createWork({ workDate: '2026-12-18', reporterId: fieldId, customerId: synCustomer, productId: synProduct, workTypeId: synWt, lotNo: null, workerIds: [synWorker], startAt: jstToInstant('2026-12-18', '09:00'), endAt: jstToInstant('2026-12-18', '10:00'), quantity: 5, defects: [], workLocationId: null, vehicleId: null, remarks: null }, ctx);

    const plan = await purgeTestData(t.store, { prefix: 'TEST-', userPrefix: 'test.', apply: false, actorId: adminId, reason: '', now: NOW });
    expect(plan).toMatchObject({ applied: false, customers: ['TEST-C01', 'TEST-C02'], reports: { work: 12, delivery: 6 }, users: ['test.field01', 'test.field02', 'test.office01'] });
    expect(plan.deactivated).toMatchObject({ customers: 2, products: 5, workers: 5, vehicles: 2, 'work-locations': 2, contacts: 2 });
    expect(await t.store.query(C.workReports)).toHaveLength(13);

    const done = await purgeTestData(t.store, { prefix: 'TEST-', userPrefix: 'test.', apply: true, actorId: adminId, reason: 'T5 現場テストの後片付け', now: NOW });
    expect(done.applied).toBe(true);
    const left = await t.store.query<ReportHeaderDoc>(C.workReports);
    expect(left.map((h) => h.id)).toEqual([keep.id]);
    expect(await t.store.query(C.deliveryReports)).toHaveLength(0);
    expect(await t.store.query(C.outbox, { where: [{ field: 'aggregateId', op: '==', value: keep.id }] })).toHaveLength(0);
    const c1 = (await readUniqueOwner(t.store, 'master:customers', '-', 'TEST-C01')) as string;
    expect((await t.store.get<Record<string, unknown>>(`${C.customers}/${c1}`))?.['active']).toBe(false);
    expect((await t.store.get<Record<string, unknown>>(`${C.customers}/${synCustomer}`))?.['active']).toBe(true);
    const u = (await t.store.get<UserDoc>(`${C.users}/${fieldId}`)) as UserDoc;
    expect(u.status).toBe('INACTIVE');
    const audit = await auditEventsFor(t.store, 'SYSTEM', (await t.store.query<{ action: string; targetId: string }>(C.auditEvents)).find((a) => a.data.action === 'TEST_DATA_PURGE')?.data.targetId as string);
    expect(audit[0]?.afterData).toMatchObject({ prefix: 'TEST-', reports: { work: 12, delivery: 6 } });
    // 作成時の監査は残る
    expect((await t.store.query<{ action: string }>(C.auditEvents)).filter((a) => a.data.action === 'WORK_REPORT_CREATE').length).toBe(13);
    // もう一度実行しても何も無い
    const again = await purgeTestData(t.store, { prefix: 'TEST-', userPrefix: 'test.', apply: true, actorId: adminId, reason: '再実行', now: NOW });
    expect(again).toMatchObject({ reports: { work: 0, delivery: 0 }, users: [], deactivated: {} });

    // 試験用データ一式をもう一度取り込むと、無効化したマスタは有効に戻る（開発環境での繰り返しの確認に使う）
    const re = await importWorkbook(t.store, await readWorkbook(await writeTemplate(true)), { apply: true, actorId: adminId, reason: '再登録', now: NOW, hashPassword: async () => 'h' });
    expect(re.counts.error, JSON.stringify(re.rows.filter((x) => x.action === 'error'))).toBe(0);
    expect(re.counts.create).toBe(0);
    expect(re.counts.update).toBeGreaterThanOrEqual(18);
    expect((await t.store.get<Record<string, unknown>>(`${C.customers}/${c1}`))?.['active']).toBe(true);
  });

  it('接頭辞が短すぎると中止（誤って全部を対象にしない）', async () => {
    await expect(purgeTestData(t.store, { prefix: 'T', userPrefix: '', apply: false, actorId: adminId, reason: '', now: NOW })).rejects.toThrow('3文字以上');
  });
});
