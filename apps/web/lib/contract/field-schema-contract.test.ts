/**
 * G3-CONTRACT（CHG-002）: 現場入力の Zod（lib/field/schemas）⇔ openapi WorkDraft / WorkUpdate / DeliveryDraft / DeliveryUpdate / Command。
 * 正常・境界・必須欠落・型不一致・未知field で受理/拒否が一致することを検査する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ZodTypeAny } from 'zod';
import { findSpecFile } from '../testing/spec-files';
import { deliveryDraftSchema, deliveryUpdateSchema, fieldCommandSchema, workDraftSchema, workUpdateSchema } from '../field/schemas';

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as {
  components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
};
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const v = (name: string) => {
  const fn = ajv.getSchema(`o#/components/schemas/${name}`);
  if (!fn) throw new Error(name);
  return fn;
};

const U = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const work = {
  workDate: '2026-10-08',
  reporterId: U,
  customerId: U,
  productId: U,
  workTypeId: U,
  lotNo: 'LOT-1',
  workerIds: [U, U2],
  startAt: '2026-10-08T04:00:00Z',
  endAt: '2026-10-08T09:00:00.000+09:00',
  quantity: 0,
  defects: [{ defectTypeId: U, quantity: 0 }],
};
const delivery = { deliveryDate: '2026-10-08', driverId: U, customerId: U, items: [{ productId: U, quantity: 1 }] };

function without<T extends Record<string, unknown>>(o: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...o };
  delete copy[key];
  return copy;
}

const workCases: Array<[string, unknown]> = [
  ['正常', work],
  ['lotNo 省略', without(work, 'lotNo')],
  ['lotNo null', { ...work, lotNo: null }],
  ['lotNo 100字', { ...work, lotNo: 'x'.repeat(100) }],
  ['lotNo 101字', { ...work, lotNo: 'x'.repeat(101) }],
  ['defects 空', { ...work, defects: [] }],
  ['workerIds 空', { ...work, workerIds: [] }],
  ['workerIds 重複', { ...work, workerIds: [U, U] }],
  ['quantity 負', { ...work, quantity: -1 }],
  ['quantity 小数', { ...work, quantity: 1.5 }],
  ['quantity 文字列', { ...work, quantity: '1' }],
  ['workDate 不正日', { ...work, workDate: '2026-02-30' }],
  ['startAt timezone なし', { ...work, startAt: '2026-10-08T04:00:00' }],
  ['startAt 日付のみ', { ...work, startAt: '2026-10-08' }],
  ['customerId uuid でない', { ...work, customerId: 'abc' }],
  ['defect 未知field', { ...work, defects: [{ defectTypeId: U, quantity: 1, note: 'x' }] }],
  ['defect quantity 負', { ...work, defects: [{ defectTypeId: U, quantity: -1 }] }],
  ['未知field', { ...work, proxyNote: '代理' }],
  // CHG-012 代理入力の理由（作成時だけ、500文字まで）
  ['proxyReason 501文字', { ...work, proxyReason: 'あ'.repeat(501) }],
  ...(['workDate', 'reporterId', 'customerId', 'productId', 'workTypeId', 'workerIds', 'startAt', 'endAt', 'quantity', 'defects'] as const).map(
    (k): [string, unknown] => [`必須欠落 ${k}`, without(work, k)],
  ),
];

const deliveryCases: Array<[string, unknown]> = [
  ['正常', delivery],
  ['items 空', { ...delivery, items: [] }],
  ['quantity 0', { ...delivery, items: [{ productId: U, quantity: 0 }] }],
  ['item 未知field', { ...delivery, items: [{ productId: U, quantity: 1, x: 1 }] }],
  ['未知field', { ...delivery, tripNo: 1 }],
  ['driverId 不正', { ...delivery, driverId: 'x' }],
  ...(['deliveryDate', 'driverId', 'customerId', 'items'] as const).map((k): [string, unknown] => [`必須欠落 ${k}`, without(delivery, k)]),
];

function compare(name: string, schema: ZodTypeAny, cases: Array<[string, unknown]>) {
  describe(`G3-CONTRACT: ${name}`, () => {
    it.each(cases)('%s: Zod と openapi の受理/拒否が一致', (_label, body) => {
      const openapi = v(name)(body) as boolean;
      const zod = schema.safeParse(body).success;
      expect(zod).toBe(openapi);
    });
  });
}

compare('WorkDraft', workDraftSchema, workCases);
compare('WorkUpdate', workUpdateSchema, [
  ['正常（expectedVersion あり）', { ...work, expectedVersion: 1 }],
  ['expectedVersion 欠落', work],
  ['expectedVersion 0', { ...work, expectedVersion: 0 }],
  ...workCases.filter(([l]) => l !== '正常').map(([l, b]): [string, unknown] => [l, { ...(b as object), expectedVersion: 3 }]),
]);
compare('DeliveryDraft', deliveryDraftSchema, deliveryCases);
compare('DeliveryUpdate', deliveryUpdateSchema, [
  ['正常（expectedVersion あり）', { ...delivery, expectedVersion: 1 }],
  ['expectedVersion 欠落', delivery],
  ...deliveryCases.filter(([l]) => l !== '正常').map(([l, b]): [string, unknown] => [l, { ...(b as object), expectedVersion: 2 }]),
]);
compare('Command', fieldCommandSchema, [
  ['expectedVersion のみ', { expectedVersion: 1 }],
  ['reason 付き', { expectedVersion: 1, reason: '理由' }],
  ['reason 1001字', { expectedVersion: 1, reason: 'x'.repeat(1001) }],
  ['未知field', { expectedVersion: 1, x: 1 }],
  ['expectedVersion 欠落', {}],
]);

describe('G3-CONTRACT: CHG-002 の openapi 是正', () => {
  it('WorkUpdate / DeliveryUpdate が正常 body を受理する（CHG-002 前は allOf + additionalProperties:false で全件不合格）', () => {
    expect(v('WorkUpdate')({ ...work, expectedVersion: 1 })).toBe(true);
    expect(v('DeliveryUpdate')({ ...delivery, expectedVersion: 1 })).toBe(true);
  });
  it('Update は Draft の全項目＋expectedVersion（項目・必須の一致）', () => {
    for (const [draft, update] of [['WorkDraft', 'WorkUpdate'], ['DeliveryDraft', 'DeliveryUpdate']] as const) {
      const d = doc.components.schemas[draft];
      const u = doc.components.schemas[update];
      // CHG-012: proxyReason（代理入力の理由）は作成時だけ
      expect(Object.keys(u?.properties ?? {}).sort()).toEqual([...Object.keys(d?.properties ?? {}).filter((k) => k !== 'proxyReason'), 'expectedVersion'].sort());
      expect([...(u?.required ?? [])].sort()).toEqual([...(d?.required ?? []), 'expectedVersion'].sort());
    }
  });
  it('Zod の項目名が openapi と一致', () => {
    expect(Object.keys(workDraftSchema.shape).sort()).toEqual(Object.keys(doc.components.schemas['WorkDraft']?.properties ?? {}).sort());
    expect(Object.keys(deliveryDraftSchema.shape).sort()).toEqual(Object.keys(doc.components.schemas['DeliveryDraft']?.properties ?? {}).sort());
  });
  it('GET 応答 schema（WorkReportDetail / DeliveryReportDetail）が定義されている', () => {
    expect(doc.components.schemas['WorkReportDetail']?.required).toContain('revisionNo');
    expect(doc.components.schemas['DeliveryReportDetail']?.required).toContain('items');
  });
});
