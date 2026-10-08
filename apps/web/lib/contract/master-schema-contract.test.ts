/**
 * G2-CONTRACT（CHG-001）: マスタ10種の Zod（lib/masters）⇔ openapi *Write / *Update の同値性。
 * 各typeで 正常・必須欠落・最大長超過・型不一致・未知field を生成し、受理/拒否が一致することを検査する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { findSpecFile } from '../testing/fresh-db';
import { MASTER_DEFS, MASTER_TYPES, type FieldDef } from '../masters/definitions';
import { writeSchema, updateSchema } from '../masters/schemas';

type Schema = { required: string[]; properties: Record<string, { maxLength?: number }> };
const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as {
  components: { schemas: Record<string, Schema & Record<string, unknown>> };
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
function sampleValue(f: FieldDef): unknown {
  switch (f.kind) {
    case 'code': return 'C-01';
    case 'text': return '名称';
    case 'textNullable': return null;
    case 'email': return 'tanto@example.com';
    case 'uuid': return U;
    case 'uuidNullable': return null;
    case 'int': return f.min ?? 1;
    case 'yen': return 2500;
    case 'decimal14_4': return '1500.25';
    case 'decimal4_4': return '1.25';
    case 'bool': return true;
    case 'date': return '2026-10-01';
    case 'dateNullable': return null;
    case 'enum': return f.enumValues?.[0];
    case 'uuidArray': return [U];
  }
}
function wrongType(f: FieldDef): unknown {
  return ['int', 'yen', 'bool', 'uuidArray'].includes(f.kind) ? 'x' : 12345;
}

describe('G2-CONTRACT: openapi に10種の個別schemaがある', () => {
  it('x-inspexor-type-map と MASTER_DEFS の schemaName が一致', () => {
    const map = doc.components.schemas['x-inspexor-type-map'] as unknown as Record<string, string>;
    for (const type of MASTER_TYPES) expect(map[type]).toBe(MASTER_DEFS[type].schemaName);
  });
  it.each(MASTER_TYPES)('%s: 項目名・必須・最大長が openapi と一致', (type) => {
    const def = MASTER_DEFS[type];
    const s = doc.components.schemas[def.schemaName] as Schema;
    expect(def.fields.map((f) => f.api).sort()).toEqual(Object.keys(s.properties).sort());
    expect(def.fields.filter((f) => f.required).map((f) => f.api).sort()).toEqual([...s.required].sort());
    for (const f of def.fields) {
      if (f.max !== undefined && ['code', 'text', 'textNullable', 'email'].includes(f.kind)) {
        expect(s.properties[f.api]?.maxLength, `${type}.${f.api}`).toBe(f.max);
      }
    }
  });
});

for (const type of MASTER_TYPES) {
  const def = MASTER_DEFS[type];
  const base: Record<string, unknown> = {};
  for (const f of def.fields) if (f.required) base[f.api] = sampleValue(f);
  const full: Record<string, unknown> = {};
  for (const f of def.fields) full[f.api] = sampleValue(f);

  const cases: Array<[string, Record<string, unknown>]> = [
    ['必須のみ', base],
    ['全項目', full],
    ['未知field', { ...base, unknownField: 1 }],
  ];
  for (const f of def.fields) {
    if (f.required) {
      const missing = { ...base };
      delete missing[f.api];
      cases.push([`${f.api} 欠落`, missing]);
    }
    cases.push([`${f.api} 型不一致`, { ...base, [f.api]: wrongType(f) }]);
    if (f.max !== undefined && ['code', 'text', 'email'].includes(f.kind)) {
      const over = f.kind === 'email' ? `${'a'.repeat(f.max)}@x.jp` : 'あ'.repeat(f.max + 1);
      cases.push([`${f.api} 最大長+1`, { ...base, [f.api]: over }]);
      if (f.kind !== 'email') cases.push([`${f.api} 最大長ちょうど`, { ...base, [f.api]: 'あ'.repeat(f.max) }]);
    }
  }

  describe(`G2-CONTRACT: ${type}（${def.schemaName}）Zod ⇔ openapi`, () => {
    it.each(cases)('Write %s: 受理/拒否が一致', (_label, body) => {
      expect(writeSchema(def).safeParse(body).success).toBe(v(def.schemaName)(body));
    });
    it.each(cases)('Update %s: 受理/拒否が一致', (_label, body) => {
      const upd = { ...body, expectedVersion: 3, reason: '単価改定' };
      expect(updateSchema(def).safeParse(upd).success).toBe(v(def.schemaName.replace('Write', 'Update'))(upd));
    });
    it('Update: reason 欠落・expectedVersion 0 は両方拒否', () => {
      const noReason = { ...base, expectedVersion: 1 };
      const v0 = { ...base, expectedVersion: 0, reason: 'r' };
      for (const body of [noReason, v0]) {
        expect(updateSchema(def).safeParse(body).success).toBe(false);
        expect(v(def.schemaName.replace('Write', 'Update'))(body)).toBe(false);
      }
    });
  });
}
