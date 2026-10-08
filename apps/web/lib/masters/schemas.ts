/**
 * MASTER_DEFS から Zod schema を生成（openapi *Write/*Update と同値。contract test で照合）。
 * 文字列は trim（API設計書）、業務code は NFKC 正規化、email は小文字化（DB設計書）。
 */
import { z } from 'zod';
import type { FieldDef, MasterDef } from './definitions';

// ajv-formats の uuid と同じ判定（Zod 3/4 の差異を避けるため自前regex）
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const uuid = () => z.string().regex(UUID_RE, 'uuid形式ではありません');
const date = () => z.string().refine(isCalendarDate, 'YYYY-MM-DD形式の日付ではありません');

function baseSchema(f: FieldDef): z.ZodType {
  switch (f.kind) {
    case 'code':
      return z.string().trim().min(1).max(f.max ?? 100).transform((s) => s.normalize('NFKC'));
    case 'text':
      return z.string().trim().min(1).max(f.max ?? 200);
    case 'textNullable':
      return z.string().trim().max(f.max ?? 200).nullable();
    case 'email':
      return z.string().trim().max(f.max ?? 320).email().transform((s) => s.toLowerCase());
    case 'uuid':
      return uuid();
    case 'uuidNullable':
      return uuid().nullable();
    case 'int': {
      let s = z.number().int();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    case 'yen':
      return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
    case 'decimal14_4':
      return z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, '10進数文字列（整数14桁・小数4桁まで）で指定してください');
    case 'decimal4_4':
      return z.string().regex(/^\d{1,4}(\.\d{1,4})?$/, '10進数文字列（整数4桁・小数4桁まで）で指定してください');
    case 'bool':
      return z.boolean();
    case 'date':
      return date();
    case 'dateNullable':
      return date().nullable();
    case 'enum':
      return z.enum(f.enumValues as [string, ...string[]]);
    case 'uuidArray':
      return z.array(uuid()).refine((arr) => new Set(arr).size === arr.length, '重複しています');
  }
}

function fieldSchema(f: FieldDef): z.ZodType {
  const base = baseSchema(f);
  if (f.required) return base;
  if (f.defaultValue !== undefined) return (base as z.ZodType<unknown>).default(f.defaultValue as never);
  if (f.kind === 'uuidNullable' || f.kind === 'dateNullable' || f.kind === 'textNullable') {
    return (base as z.ZodType<unknown>).default(null as never);
  }
  return base.optional();
}

function shapeOf(def: MasterDef): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of def.fields) shape[f.api] = fieldSchema(f);
  return shape;
}

export type MasterInput = Record<string, unknown>;

export function writeSchema(def: MasterDef) {
  return z.object(shapeOf(def)).strict();
}

export function updateSchema(def: MasterDef) {
  return z
    .object({
      ...shapeOf(def),
      expectedVersion: z.number().int().min(1),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict();
}

/** openapi Command: 無効化。遡及時のみ reason 必須（service側で検査） */
export const commandSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();
