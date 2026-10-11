import { afterAll, describe, expect, it } from 'vitest';
import { createTestStore } from '@inspexor/docstore/testing';
import { FieldReportService } from './field-report-service';

// CHG-006: 報告一覧のすべての絞込の組合せが Firestore で実行できる（memory では firestore.indexes.json の複合索引を検査）
const t = createTestStore('listq');
const svc = new FieldReportService(t.store);
const ID = '00000000-0000-4000-8000-000000000000';
const base = { page: 1, pageSize: 10, status: null, dateFrom: null, dateTo: null };

describe('報告一覧の検索と複合索引', () => {
  afterAll(async () => t.close());

  it('種別・本人・期間・お客様・品番・状態のすべての組合せ', async () => {
    let n = 0;
    for (const roles of [['OFFICE'], ['FIELD']]) {
      for (const type of [null, 'WORK', 'DELIVERY'] as const) {
        for (const period of [{}, { dateFrom: '2026-10-01' }, { dateTo: '2026-10-31' }, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }]) {
          for (const customerId of [null, ID]) {
            for (const productId of [null, ID]) {
              for (const status of [null, 'CONFIRMED']) {
                const r = await svc.list({ userId: ID, roles }, { ...base, ...period, type, customerId, productId, status });
                expect(r.meta.total).toBe(0);
                n += 1;
              }
            }
          }
        }
      }
    }
    expect(n).toBe(192);
  });
});
