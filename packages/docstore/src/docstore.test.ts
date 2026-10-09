import { describe, expect, it } from 'vitest';
import { docStoreContract } from './contract';
import { MemoryDocStore } from './memory';
import { findIndex, needsCompositeIndex, planQuery, type IndexDefinition } from './query';

docStoreContract('memory', () => ({ store: new MemoryDocStore(), kind: 'memory' }));

describe('MemoryDocStore: 複合索引の検査（firestore.indexes.json と同じ規則）', () => {
  const indexes: IndexDefinition[] = [
    { collectionGroup: 'workReports', queryScope: 'COLLECTION', fields: [{ fieldPath: 'ownerId', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] },
    { collectionGroup: 'workReports', queryScope: 'COLLECTION', fields: [{ fieldPath: 'productIds', arrayConfig: 'CONTAINS' }, { fieldPath: 'businessDate', order: 'DESCENDING' }] },
  ];

  it('単一項目・等価のみは索引不要、等価＋並び順は複合索引が必要', () => {
    expect(needsCompositeIndex({ where: [{ field: 'a', op: '==', value: 1 }] })).toBe(false);
    expect(needsCompositeIndex({ where: [{ field: 'a', op: '==', value: 1 }, { field: 'b', op: '==', value: 2 }] })).toBe(false);
    expect(needsCompositeIndex({ where: [{ field: 'a', op: '>=', value: 1 }], orderBy: [{ field: 'a' }] })).toBe(false);
    expect(needsCompositeIndex({ where: [{ field: 'a', op: '==', value: 1 }], orderBy: [{ field: 'b' }] })).toBe(true);
  });

  it('索引の照合（向き・array-contains を区別）', () => {
    const q1 = { where: [{ field: 'ownerId', op: '==' as const, value: 'u' }], orderBy: [{ field: 'createdAt', dir: 'desc' as const }] };
    expect(findIndex('workReports', q1, planQuery('workReports', q1).orders, indexes)).not.toBeNull();
    const q2 = { where: [{ field: 'ownerId', op: '==' as const, value: 'u' }], orderBy: [{ field: 'createdAt', dir: 'asc' as const }] };
    expect(findIndex('workReports', q2, planQuery('workReports', q2).orders, indexes)).toBeNull();
    const q3 = { where: [{ field: 'productIds', op: 'array-contains' as const, value: 'p' }], orderBy: [{ field: 'businessDate', dir: 'desc' as const }] };
    expect(findIndex('workReports', q3, planQuery('workReports', q3).orders, indexes)).not.toBeNull();
    expect(findIndex('deliveryReports', q3, planQuery('deliveryReports', q3).orders, indexes)).toBeNull();
  });

  it('索引が無い検索は INDEX_REQUIRED（本番の Firestore と同じく失敗させる）', async () => {
    const store = new MemoryDocStore({ indexes });
    await expect(store.query('deliveryReports', { where: [{ field: 'ownerId', op: '==', value: 'u' }], orderBy: [{ field: 'createdAt', dir: 'desc' }] })).rejects.toMatchObject({ code: 'INDEX_REQUIRED' });
    await expect(store.query('workReports', { where: [{ field: 'ownerId', op: '==', value: 'u' }], orderBy: [{ field: 'createdAt', dir: 'desc' }] })).resolves.toEqual([]);
  });

  it('Firestore で実行できない検索は INVALID（範囲条件が2項目、範囲と異なる最初の並び順、in 31件）', () => {
    expect(() => planQuery('x', { where: [{ field: 'a', op: '>', value: 1 }, { field: 'b', op: '<', value: 1 }] })).toThrow();
    expect(() => planQuery('x', { where: [{ field: 'a', op: '>', value: 1 }], orderBy: [{ field: 'b' }] })).toThrow();
    expect(() => planQuery('x', { where: [{ field: 'a', op: 'in', value: Array.from({ length: 31 }, (_, i) => i) }] })).toThrow();
  });
});
