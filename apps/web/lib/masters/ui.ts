/**
 * SCR-13 マスター管理の表示定義（v6.0 ワイヤーフレーム準拠の名称・一覧列）と、フォーム値⇔API body の変換。
 * 業務値は推測せず、項目は MASTER_DEFS（= openapi CHG-001）から取る。
 */
import { MASTER_DEFS, type FieldDef, type MasterDef, type MasterType } from './definitions';

/**
 * CHG-004: 提案書「マスタ管理（簡易）: 客先・品番・作業者・不良項目」＋作業場所・車両（D1）を表示する。
 * 単価/運搬/固定費ルール（請求）は対象外のため一覧に出さない（Blind）。CHG-009: 請求機能が有効なら表示する（masterNav）。
 * お客様担当者は CHG-005 で日報（作業結果報告書）の「担当者」欄に使うため表示する（メール送信は停止中）。
 */
export const ALL_MASTER_LABELS: Readonly<Record<MasterType, string>> = {
  customers: 'お客様',
  contacts: 'お客様担当者',
  products: '品番',
  'work-types': '作業内容',
  defects: '不良種別',
  workers: '作業者',
  'work-locations': '作業場所',
  vehicles: '車両',
  holidays: '休日',
  rates: '単価ルール',
  'transport-rules': '運搬ルール',
  'fixed-charges': '固定費',
};

const VISIBLE_MASTERS: readonly MasterType[] = ['customers', 'contacts', 'products', 'work-types', 'defects', 'workers', 'work-locations', 'vehicles', 'holidays'];

/** CHG-009: 請求機能（BILLING_ENABLED）が有効なときだけ表示する請求マスタ */
const BILLING_MASTERS: readonly MasterType[] = ['rates', 'transport-rules', 'fixed-charges'];

export const MASTER_NAV: ReadonlyArray<{ type: MasterType; label: string }> = VISIBLE_MASTERS.map((type) => ({ type, label: ALL_MASTER_LABELS[type] }));

/** マスター種別の一覧（請求機能が有効なら 単価・運搬・固定費ルールを足す） */
export function masterNav(billing: boolean): ReadonlyArray<{ type: MasterType; label: string }> {
  return billing ? [...MASTER_NAV, ...BILLING_MASTERS.map((type) => ({ type, label: ALL_MASTER_LABELS[type] }))] : MASTER_NAV;
}

export const NAV_LABEL: Readonly<Record<MasterType, string>> = ALL_MASTER_LABELS;

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  code: 'コード',
  name: '名称',
  closingDay: '締日',
  customerId: 'お客様',
  email: 'メールアドレス',
  sendDaily: '日報メール（現在は送信停止中）',
  sendInvoice: '請求書メール（対象外）',
  dailyProductIds: '日報の担当品番（作業結果報告書の担当者欄）',
  invoiceProductIds: '請求書の担当品番',
  settlementType: '精算',
  lotRequired: 'ロット番号',
  productId: '品番',
  workTypeId: '作業内容',
  sortOrder: '表示順',
  holidayDate: '日付',
  unitPrice: '単価（円）',
  overtimeMultiplier: '割増倍率',
  validFrom: '適用開始日',
  validTo: '適用終了日',
  transportType: '運搬区分',
  amountYen: '金額（円）',
  allocationGroup: '按分グループ',
  label: '費目',
  active: '有効',
};

export const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  settlementType: { QUANTITY: '個数', TIME: '時間' },
  transportType: { ALLOCATED: '按分（1便を対象品番で按分）', PER_TRIP: '便ごと', MONTHLY_FIXED: '月額固定', NONE: 'なし' },
};

/** 一覧に表示する列（v6.0 SCR-13: 品番 = コード/品名/お客様/精算/ロット/状態） */
export const LIST_COLUMNS: Readonly<Record<MasterType, readonly string[]>> = {
  customers: ['code', 'name', 'closingDay'],
  contacts: ['code', 'name', 'customerId', 'email', 'sendDaily', 'sendInvoice'],
  products: ['code', 'name', 'customerId', 'settlementType', 'lotRequired'],
  'work-types': ['code', 'name', 'productId'],
  defects: ['code', 'name', 'productId', 'sortOrder'],
  workers: ['code', 'name'],
  holidays: ['holidayDate', 'name'],
  rates: ['productId', 'workTypeId', 'unitPrice', 'overtimeMultiplier', 'validFrom', 'validTo'],
  'transport-rules': ['productId', 'transportType', 'amountYen', 'allocationGroup', 'validFrom', 'validTo'],
  'fixed-charges': ['productId', 'label', 'amountYen', 'validFrom', 'validTo'],
  vehicles: ['code', 'name'],
  'work-locations': ['code', 'name'],
};

export const NAME_LABEL_OVERRIDE: Partial<Record<MasterType, string>> = { products: '品名', 'work-types': '作業内容名', defects: '不良名', workers: '氏名', contacts: '氏名', vehicles: '車両名', 'work-locations': '作業場所名' };

export function fieldLabel(type: MasterType, api: string): string {
  if (api === 'name' && NAME_LABEL_OVERRIDE[type] !== undefined) return NAME_LABEL_OVERRIDE[type] as string;
  return FIELD_LABELS[api] ?? api;
}

export interface LookupEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly customerId?: string;
  readonly productId?: string;
  readonly active: boolean;
}
export type Lookups = Readonly<Record<'customers' | 'products' | 'work-types', ReadonlyMap<string, LookupEntry>>>;

const PARENT_LOOKUP: Readonly<Record<string, keyof Lookups>> = {
  customerId: 'customers',
  productId: 'products',
  workTypeId: 'work-types',
};

export function parentLookupOf(api: string): keyof Lookups | undefined {
  return PARENT_LOOKUP[api];
}

/** 表示用整形（金額は円・カンマ、10進は末尾0除去、真偽は業務語、参照はコード＋名称） */
export function formatCell(type: MasterType, api: string, value: unknown, lookups: Lookups): string {
  if (value === null || value === undefined || value === '') {
    if (api === 'workTypeId') return '全作業';
    if (api === 'validTo') return '無期限';
    return '—';
  }
  const lookupKey = parentLookupOf(api);
  if (lookupKey !== undefined) {
    const entry = lookups[lookupKey].get(String(value));
    return entry !== undefined ? `${entry.code} ${entry.name}` : String(value);
  }
  if (ENUM_LABELS[api] !== undefined) return ENUM_LABELS[api]?.[String(value)] ?? String(value);
  if (api === 'lotRequired') return value === true ? '必須' : '任意';
  if (typeof value === 'boolean') return value ? 'する' : 'しない';
  if (api === 'amountYen') return `¥${Number(value).toLocaleString('ja-JP')}`;
  if (api === 'unitPrice' || api === 'overtimeMultiplier') {
    const s = String(value);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  if (api === 'closingDay') return Number(value) === 31 ? '月末' : `${String(value)}日`;
  if (Array.isArray(value)) return `${value.length}件`;
  void type;
  return String(value);
}

export type FormState = Record<string, string | boolean | string[]>;

export function emptyFormState(def: MasterDef): FormState {
  const state: FormState = {};
  for (const f of def.fields) {
    if (f.kind === 'bool') state[f.api] = (f.defaultValue as boolean | undefined) ?? false;
    else if (f.kind === 'uuidArray') state[f.api] = [];
    else state[f.api] = f.defaultValue !== undefined ? String(f.defaultValue) : '';
  }
  return state;
}

export function recordToFormState(def: MasterDef, record: Record<string, unknown>): FormState {
  const state = emptyFormState(def);
  for (const f of def.fields) {
    const v = record[f.api];
    if (f.kind === 'bool') state[f.api] = v === true;
    else if (f.kind === 'uuidArray') state[f.api] = Array.isArray(v) ? (v as string[]) : [];
    else state[f.api] = v === null || v === undefined ? '' : String(v);
  }
  return state;
}

function convert(f: FieldDef, raw: string | boolean | string[]): unknown {
  if (f.kind === 'bool' || f.kind === 'uuidArray') return raw;
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') {
    return f.kind === 'uuidNullable' || f.kind === 'dateNullable' || f.kind === 'textNullable' ? null : undefined;
  }
  if (f.kind === 'int' || f.kind === 'yen') {
    // 整数でない入力は文字列のまま送り、server の 422 で項目エラーを表示する
    return /^-?\d+$/.test(s) ? Number(s) : s;
  }
  return s;
}

/** フォーム値 → API body（空の必須項目は送らず server の必須エラーに委ねる） */
export function formStateToPayload(def: MasterDef, state: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of def.fields) {
    const value = convert(f, state[f.api] ?? '');
    if (value !== undefined) body[f.api] = value;
  }
  return body;
}

export function masterDef(type: MasterType): MasterDef {
  return MASTER_DEFS[type];
}
