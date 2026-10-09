/**
 * 合成マスタ（EXT-02 未提供時の deterministic synthetic seed）。CHG-006: Firestore 版。
 * MasterService を通して作る（一意キー・監査も本番と同じ経路）。既存 code はスキップするため何度実行しても同じ状態。
 * 請求専用マスタ（Blind）は作らない。scripts/seed-masters.ts と結合試験から使う。
 */
import { randomUUID } from 'node:crypto';
import { readUniqueOwner, type DocStore } from '@inspexor/docstore';
import { MasterService } from './master-service';
import { MASTER_DEFS, type MasterType } from './definitions';
import { writeSchema } from './schemas';

export async function seedMasters(store: DocStore, actorId: string, now: Date): Promise<Record<string, number>> {
  const service = new MasterService(store);
  const counts: Record<string, number> = {};
  const ctx = { actorId, correlationId: randomUUID(), now };

  async function ensure(type: MasterType, input: Record<string, unknown>): Promise<string> {
    const def = MASTER_DEFS[type];
    const scope = def.uniqueScope === null ? '-' : String(input[def.uniqueScope]);
    const existing = await readUniqueOwner(store, `master:${type}`, scope, String(input[def.uniqueField]));
    if (existing !== null) return existing;
    const parsed = writeSchema(def).parse(input) as Record<string, unknown>;
    const created = await service.create(type, parsed, ctx);
    counts[type] = (counts[type] ?? 0) + 1;
    return created.id;
  }

  const customerId = await ensure('customers', { code: 'SYN-C01', name: '合成顧客A', closingDay: 31 });
  const products: Array<[string, string, string]> = [
    ['SYN-P01', '合成品番01（運搬対象）', 'QUANTITY'],
    ['SYN-P02', '合成品番02（運搬対象）', 'QUANTITY'],
    ['SYN-P03', '合成品番03（運搬対象）', 'QUANTITY'],
    ['SYN-P04', '合成品番04（運搬対象）', 'QUANTITY'],
    ['SYN-P05', '合成品番05（時間精算）', 'TIME'],
  ];
  const productIds: string[] = [];
  for (const [code, name, settlementType] of products) {
    const productId = await ensure('products', { customerId, code, name, settlementType });
    productIds.push(productId);
    await ensure('work-types', { productId, code: 'INSP', name: '検査' });
    for (const [i, [dcode, dname]] of ([['D01', 'バリ'], ['D02', '欠け']] as const).entries()) {
      await ensure('defects', { productId, code: dcode, name: dname, sortOrder: i + 1 });
    }
  }
  for (const [code, name] of [['SYN-W01', '合成作業者1'], ['SYN-W02', '合成作業者2'], ['SYN-W03', '合成運転者']]) {
    await ensure('workers', { code, name });
  }
  await ensure('contacts', {
    customerId,
    code: 'SYN-K01',
    name: '合成担当者',
    email: 'synthetic-contact@example.com',
    sendDaily: true,
    sendInvoice: true,
    dailyProductIds: productIds,
    invoiceProductIds: productIds,
  });
  for (const [holidayDate, name] of [['2026-01-01', '合成休日（元日）'], ['2026-05-04', '合成休日'], ['2026-11-03', '合成休日']]) {
    await ensure('holidays', { holidayDate, name });
  }
  for (const [code, name] of [['SYN-V01', '合成車両キャンター'], ['SYN-V02', '合成車両キャラバン']]) {
    await ensure('vehicles', { code, name });
  }
  for (const [code, name] of [['SYN-L01', '合成作業場（自社）'], ['SYN-L02', '合成作業場（客先常駐）']]) {
    await ensure('work-locations', { code, name });
  }
  return counts;
}
