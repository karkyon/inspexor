import { afterAll, describe, expect, it } from 'vitest';
import { createTestStore } from '@inspexor/docstore/testing';
import { MasterService } from './master-service';
import { seedMasters } from './synthetic-seed';

const t = createTestStore('seed');
const now = new Date('2026-10-09T00:00:00Z');

describe('合成マスタ seed（CHG-006）', () => {
  afterAll(async () => t.close());

  it('1回目で全件作成、2回目は何も作らない。品番5・作業種5・不良10・作業者3・担当者1（担当品番5）・休日3・車両2・作業場所2', async () => {
    const first = await seedMasters(t.store, 'seed-actor', now);
    expect(first).toEqual({ customers: 1, products: 5, 'work-types': 5, defects: 10, workers: 3, contacts: 1, holidays: 3, vehicles: 2, 'work-locations': 2 });
    expect(await seedMasters(t.store, 'seed-actor', now)).toEqual({});
    const service = new MasterService(t.store);
    const products = (await service.list('products', 1, 100)).data;
    expect(products.map((p) => p['code'])).toEqual(['SYN-P01', 'SYN-P02', 'SYN-P03', 'SYN-P04', 'SYN-P05']);
    const contacts = (await service.list('contacts', 1, 100)).data;
    expect((contacts[0]?.['dailyProductIds'] as string[]).length).toBe(5);
    const defects = (await service.list('defects', 1, 100)).data;
    expect(defects.slice(0, 2).map((d) => d['name'])).toEqual(['バリ', '欠け']);
  });
});
