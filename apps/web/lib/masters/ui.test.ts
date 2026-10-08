import { describe, it, expect } from 'vitest';
import { MASTER_DEFS, MASTER_TYPES } from './definitions';
import { MASTER_NAV, LIST_COLUMNS, FIELD_LABELS, emptyFormState, formStateToPayload, recordToFormState, formatCell, type Lookups } from './ui';
import { writeSchema } from './schemas';

const lookups: Lookups = {
  customers: new Map([['c1', { id: 'c1', code: 'SYN-C01', name: '合成顧客A', active: true }]]),
  products: new Map(),
  'work-types': new Map(),
};

describe('SCR-13 表示定義', () => {
  it('ナビは10種すべて・重複なし', () => {
    expect(MASTER_NAV.map((n) => n.type).sort()).toEqual([...MASTER_TYPES].sort());
  });
  it('一覧列・全項目にラベルがあり、定義済み項目だけを使う', () => {
    for (const type of MASTER_TYPES) {
      const apis = MASTER_DEFS[type].fields.map((f) => f.api);
      for (const col of LIST_COLUMNS[type]) expect(apis).toContain(col);
      for (const api of apis) expect(FIELD_LABELS[api], `${type}.${api}`).toBeDefined();
    }
  });
});

describe('SCR-13 フォーム変換', () => {
  it('空フォーム→payload は必須項目を送らない（server の必須エラーに委ねる）、既定値は送る', () => {
    const body = formStateToPayload(MASTER_DEFS.rates, emptyFormState(MASTER_DEFS.rates));
    expect(body).toEqual({ workTypeId: null, overtimeMultiplier: '1.25', validTo: null, active: true });
  });
  it('数値・日付・null可を正しく変換し、Zod を通る', () => {
    const def = MASTER_DEFS['transport-rules'];
    const state = { ...emptyFormState(def), productId: '11111111-1111-4111-8111-111111111111', transportType: 'ALLOCATED', amountYen: ' 2500 ', validFrom: '2026-01-01', allocationGroup: '' };
    const body = formStateToPayload(def, state);
    expect(body).toMatchObject({ amountYen: 2500, validFrom: '2026-01-01', allocationGroup: null, validTo: null, workTypeId: null });
    expect(writeSchema(def).safeParse(body).success).toBe(true);
  });
  it('整数でない金額は文字列のまま（server 422 で表示）', () => {
    const def = MASTER_DEFS['fixed-charges'];
    expect(formStateToPayload(def, { ...emptyFormState(def), amountYen: '12.5' })['amountYen']).toBe('12.5');
  });
  it('record → form → payload が往復で一致', () => {
    const def = MASTER_DEFS.contacts;
    const record = { customerId: 'c1', code: 'K1', name: '担当', email: 'a@example.com', sendDaily: true, sendInvoice: false, dailyProductIds: ['p1'], invoiceProductIds: [], active: true };
    expect(formStateToPayload(def, recordToFormState(def, record))).toEqual(record);
  });
});

describe('SCR-13 セル表示', () => {
  it('参照・区分・金額・真偽・期間を業務語で表示', () => {
    expect(formatCell('products', 'customerId', 'c1', lookups)).toBe('SYN-C01 合成顧客A');
    expect(formatCell('products', 'settlementType', 'TIME', lookups)).toBe('時間');
    expect(formatCell('products', 'lotRequired', true, lookups)).toBe('必須');
    expect(formatCell('fixed-charges', 'amountYen', 2500, lookups)).toBe('¥2,500');
    expect(formatCell('rates', 'unitPrice', '12.5000', lookups)).toBe('12.5');
    expect(formatCell('rates', 'validTo', null, lookups)).toBe('無期限');
    expect(formatCell('rates', 'workTypeId', null, lookups)).toBe('全作業');
    expect(formatCell('customers', 'closingDay', 31, lookups)).toBe('月末');
  });
});
