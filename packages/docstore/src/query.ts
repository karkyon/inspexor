import { DocStoreError, type Doc, type Filter, type Order, type QuerySpec, type Value } from './types';
import { compareValues, fieldValue, sameType, valuesEqual } from './values';

const RANGE_OPS = new Set(['<', '<=', '>', '>=']);
const EQUALITY_OPS = new Set(['==', 'in', 'array-contains']);

/** firestore.indexes.json の1件 */
export interface IndexField {
  readonly fieldPath: string;
  readonly order?: 'ASCENDING' | 'DESCENDING';
  readonly arrayConfig?: 'CONTAINS';
}
export interface IndexDefinition {
  readonly collectionGroup: string;
  readonly queryScope?: 'COLLECTION' | 'COLLECTION_GROUP';
  readonly fields: readonly IndexField[];
}

/**
 * Firestore で実行できる形かを検証し、実際の並び順（不等号の項目が先頭・最後に文書 ID）を返す。
 * 本番と同じ失敗を開発中に出すため、Firestore より厳しめに制限する:
 *  - 範囲条件は1項目のみ。orderBy を指定するときは最初の orderBy が範囲条件の項目
 *  - array-contains は1つのみ、in の値は配列で 1〜30 件
 */
export function planQuery(collection: string, spec: QuerySpec): { orders: Order[]; filters: Filter[] } {
  const filters = [...(spec.where ?? [])];
  const rangeFields = [...new Set(filters.filter((f) => RANGE_OPS.has(f.op)).map((f) => f.field))];
  if (rangeFields.length > 1) throw new DocStoreError('INVALID', `${collection}: range filters on multiple fields (${rangeFields.join(', ')})`);
  if (filters.filter((f) => f.op === 'array-contains').length > 1) throw new DocStoreError('INVALID', `${collection}: multiple array-contains`);
  for (const f of filters) {
    if (f.op === 'in' && (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 30)) {
      throw new DocStoreError('INVALID', `${collection}: "in" needs 1..30 values (${f.field})`);
    }
  }
  const orders = [...(spec.orderBy ?? [])];
  const range = rangeFields[0];
  if (range !== undefined) {
    if (orders.length === 0) orders.push({ field: range, dir: 'asc' });
    else if (orders[0]?.field !== range) throw new DocStoreError('INVALID', `${collection}: first orderBy must be the range field ${range}`);
  }
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit <= 0)) {
    throw new DocStoreError('INVALID', `${collection}: limit must be a positive integer`);
  }
  return { orders, filters };
}

/** 単一項目の自動索引で足りるか（足りなければ複合索引が必要） */
export function needsCompositeIndex(spec: QuerySpec): boolean {
  const filters = spec.where ?? [];
  const orders = spec.orderBy ?? [];
  const fields = new Set([...filters.map((f) => f.field), ...orders.map((o) => o.field)]);
  if (fields.size <= 1) return false;
  const equalityOnly = orders.length === 0 && filters.every((f) => f.op === '==');
  return !equalityOnly;
}

function dirOf(o: Order): 'ASCENDING' | 'DESCENDING' {
  return o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING';
}

/** 複合索引の照合（等価条件の項目が先頭〔順不同〕、続いて並び順の項目が同じ順・同じ向き） */
export function findIndex(collectionGroup: string, spec: QuerySpec, orders: readonly Order[], indexes: readonly IndexDefinition[]): IndexDefinition | null {
  const filters = spec.where ?? [];
  const eq = filters.filter((f) => EQUALITY_OPS.has(f.op));
  const eqFields = new Map<string, boolean>(); // field -> array-contains か
  for (const f of eq) eqFields.set(f.field, (eqFields.get(f.field) ?? false) || f.op === 'array-contains');
  const ordered = orders.filter((o) => !eqFields.has(o.field));
  for (const index of indexes) {
    if (index.collectionGroup !== collectionGroup || (index.queryScope ?? 'COLLECTION') !== 'COLLECTION') continue;
    if (index.fields.length !== eqFields.size + ordered.length) continue;
    const head = index.fields.slice(0, eqFields.size);
    const tail = index.fields.slice(eqFields.size);
    const headOk = head.every((f) => {
      const isContains = eqFields.get(f.fieldPath);
      if (isContains === undefined) return false;
      return isContains ? f.arrayConfig === 'CONTAINS' : f.order !== undefined;
    });
    const tailOk = tail.every((f, i) => f.fieldPath === ordered[i]?.field && f.order === dirOf(ordered[i] as Order));
    if (headOk && tailOk) return index;
  }
  return null;
}

function matches(doc: Doc, f: Filter): boolean {
  const v = fieldValue(doc, f.field);
  if (v === undefined) return false;
  switch (f.op) {
    case '==':
      return valuesEqual(v, f.value);
    case 'in':
      return (f.value as readonly Value[]).some((x) => valuesEqual(v, x));
    case 'array-contains':
      return Array.isArray(v) && (v as readonly Value[]).some((x) => valuesEqual(x, f.value));
    default: {
      if (!sameType(v, f.value) || v === null) return false;
      const c = compareValues(v, f.value);
      return f.op === '<' ? c < 0 : f.op === '<=' ? c <= 0 : f.op === '>' ? c > 0 : c >= 0;
    }
  }
}

/** 検索の実行（Firestore と同じく、並び順の項目を持たない文書は結果に含めない） */
export function runQuery<T>(docs: ReadonlyArray<{ id: string; data: Doc }>, filters: readonly Filter[], orders: readonly Order[], limit: number | undefined): Array<{ id: string; data: T }> {
  const hit = docs.filter((d) => filters.every((f) => matches(d.data, f)) && orders.every((o) => fieldValue(d.data, o.field) !== undefined));
  const lastDir = orders.length > 0 ? orders[orders.length - 1]?.dir ?? 'asc' : 'asc';
  hit.sort((a, b) => {
    for (const o of orders) {
      const c = compareValues(fieldValue(a.data, o.field) as Value, fieldValue(b.data, o.field) as Value);
      if (c !== 0) return o.dir === 'desc' ? -c : c;
    }
    const c = Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
    return lastDir === 'desc' ? -c : c;
  });
  return (limit === undefined ? hit : hit.slice(0, limit)) as Array<{ id: string; data: T }>;
}
