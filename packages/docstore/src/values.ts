import { DocStoreError, type Doc, type Value } from './types';

/**
 * 書込値を Firestore と同じ規則で検証し、複製する（undefined の項目は除く）。
 *  - 配列の直下に配列は置けない
 *  - 配列の要素に undefined は置けない
 *  - number は有限値のみ
 *  - class インスタンス（Date 以外）は置けない
 */
export function normalizeDoc(input: object, path: string): Doc {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || input instanceof Date) {
    throw new DocStoreError('INVALID', `document data must be an object: ${path}`);
  }
  return normalizeMap(input as Record<string, unknown>, path);
}

function normalizeMap(input: Record<string, unknown>, where: string): Doc {
  const proto = Object.getPrototypeOf(input) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new DocStoreError('INVALID', `unsupported object value at ${where}`);
  }
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key.length === 0 || key.includes('.')) throw new DocStoreError('INVALID', `invalid field name "${key}" at ${where}`);
    out[key] = normalizeValue(value, `${where}.${key}`, false);
  }
  return out;
}

function normalizeValue(value: unknown, where: string, inArray: boolean): Value {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DocStoreError('INVALID', `non-finite number at ${where}`);
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new DocStoreError('INVALID', `invalid date at ${where}`);
    return new Date(value.getTime());
  }
  if (Array.isArray(value)) {
    if (inArray) throw new DocStoreError('INVALID', `nested arrays are not supported at ${where}`);
    return value.map((item, i) => {
      if (item === undefined) throw new DocStoreError('INVALID', `undefined in array at ${where}[${i}]`);
      return normalizeValue(item, `${where}[${i}]`, true);
    });
  }
  if (typeof value === 'object') return normalizeMap(value as Record<string, unknown>, where);
  throw new DocStoreError('INVALID', `unsupported value type ${typeof value} at ${where}`);
}

/** 読出し用の深い複製（呼出側が書き換えても保存値に影響しない） */
export function cloneDoc<T>(doc: Doc): T {
  return cloneValue(doc) as T;
}

function cloneValue(value: Value | undefined): Value | undefined {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((v) => cloneValue(v) as Value);
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(value as Record<string, Value>)) out[k] = cloneValue(v) as Value;
  return out;
}

/** Firestore の型順: null < boolean < number < timestamp < string < array < map */
function typeRank(value: Value | undefined): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (value instanceof Date) return 3;
  if (typeof value === 'string') return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

function compareUtf8(a: string, b: string): number {
  // Firestore の文字列順は UTF-8 のバイト順
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return Number(a) - Number(b);
    case 2:
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
    case 3:
      return (a as Date).getTime() - (b as Date).getTime();
    case 4:
      return compareUtf8(a as string, b as string);
    case 5: {
      const x = a as readonly Value[];
      const y = b as readonly Value[];
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        const c = compareValues(x[i] as Value, y[i] as Value);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    default: {
      const x = Object.entries(a as Record<string, Value>).sort(([k1], [k2]) => compareUtf8(k1, k2));
      const y = Object.entries(b as Record<string, Value>).sort(([k1], [k2]) => compareUtf8(k1, k2));
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        const [kx, vx] = x[i] as [string, Value];
        const [ky, vy] = y[i] as [string, Value];
        const ck = compareUtf8(kx, ky);
        if (ck !== 0) return ck;
        const cv = compareValues(vx, vy);
        if (cv !== 0) return cv;
      }
      return x.length - y.length;
    }
  }
}

export function sameType(a: Value, b: Value): boolean {
  return typeRank(a) === typeRank(b);
}

export function valuesEqual(a: Value, b: Value): boolean {
  return sameType(a, b) && compareValues(a, b) === 0;
}

/** 項目パス（'a.b'）の値。無ければ undefined */
export function fieldValue(doc: Doc, field: string): Value | undefined {
  let cur: Value | undefined = doc as unknown as Value;
  for (const part of field.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur) || cur instanceof Date) return undefined;
    cur = (cur as Record<string, Value | undefined>)[part];
  }
  return cur;
}
