/**
 * マスタ10種＋2種（CHG-004: 車両・作業場所）の定義（CHG-001 / docs/spec/openapi.yaml の *Write schema ⇔ schema.sql+0001 migration の列）。
 * API項目名・型・必須・長さは openapi と一致させ、contract test（master-schema-contract.test.ts）で照合する。
 */
import type { RetroactiveKind } from '@inspexor/domain';

export const MASTER_TYPES = [
  'customers',
  'contacts',
  'workers',
  'products',
  'work-types',
  'defects',
  'holidays',
  'rates',
  'transport-rules',
  'fixed-charges',
  // CHG-004 D1（提案書: 作業場所・使用車は選択）
  'vehicles',
  'work-locations',
] as const;

export type MasterType = (typeof MASTER_TYPES)[number];

export function isMasterType(value: string): value is MasterType {
  return (MASTER_TYPES as readonly string[]).includes(value);
}

export type FieldKind =
  | 'code'
  | 'text'
  | 'textNullable'
  | 'email'
  | 'uuid'
  | 'uuidNullable'
  | 'int'
  | 'yen'
  | 'decimal14_4'
  | 'decimal4_4'
  | 'bool'
  | 'date'
  | 'dateNullable'
  | 'enum'
  | 'uuidArray';

export interface ParentRef {
  readonly table: string;
  readonly label: string;
}

export interface FieldDef {
  readonly api: string;
  /** DB列。uuidArray（担当品番）は product_contacts の purpose */
  readonly column: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly enumValues?: readonly string[];
  readonly defaultValue?: string | number | boolean | readonly string[];
  /** 親マスタ参照（存在・有効性を検査、作成後は変更不可＝参照保護） */
  readonly parent?: ParentRef;
}

export interface MasterDef {
  readonly type: MasterType;
  readonly schemaName: string;
  readonly table: string;
  readonly label: string;
  readonly fields: readonly FieldDef[];
  readonly orderBy: string;
  readonly retroactive: RetroactiveKind;
  /** 遡及判定・影響算出に使う期間列 */
  readonly range?: { readonly fromApi: string; readonly toApi: string | null };
  /** 一意制約違反時に指す項目 */
  readonly uniqueField: string;
}

const active: FieldDef = { api: 'active', column: 'active', kind: 'bool', required: false, defaultValue: true };
const customerRef: ParentRef = { table: 'customers', label: '顧客' };
const productRef: ParentRef = { table: 'products', label: '品番' };
const workTypeRef: ParentRef = { table: 'work_types', label: '作業種' };

export const MASTER_DEFS: Readonly<Record<MasterType, MasterDef>> = {
  customers: {
    type: 'customers',
    schemaName: 'CustomerWrite',
    table: 'customers',
    label: '顧客',
    orderBy: 'code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'code', column: 'code', kind: 'code', required: true, max: 30 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 200 },
      { api: 'closingDay', column: 'closing_day', kind: 'int', required: true, min: 1, max: 31 },
      active,
    ],
  },
  contacts: {
    type: 'contacts',
    schemaName: 'ContactWrite',
    table: 'customer_contacts',
    label: '顧客担当者',
    orderBy: 'customer_id ASC, code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'customerId', column: 'customer_id', kind: 'uuid', required: true, parent: customerRef },
      { api: 'code', column: 'code', kind: 'code', required: true, max: 30 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      { api: 'email', column: 'email', kind: 'email', required: true, max: 320 },
      { api: 'sendDaily', column: 'send_daily', kind: 'bool', required: false, defaultValue: false },
      { api: 'sendInvoice', column: 'send_invoice', kind: 'bool', required: false, defaultValue: false },
      { api: 'dailyProductIds', column: 'DAILY', kind: 'uuidArray', required: false, defaultValue: [] },
      { api: 'invoiceProductIds', column: 'INVOICE', kind: 'uuidArray', required: false, defaultValue: [] },
      active,
    ],
  },
  workers: {
    type: 'workers',
    schemaName: 'WorkerWrite',
    table: 'workers',
    label: '作業者',
    orderBy: 'code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'code', column: 'code', kind: 'code', required: true, max: 30 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      active,
    ],
  },
  products: {
    type: 'products',
    schemaName: 'ProductWrite',
    table: 'products',
    label: '品番',
    orderBy: 'customer_id ASC, code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'customerId', column: 'customer_id', kind: 'uuid', required: true, parent: customerRef },
      { api: 'code', column: 'code', kind: 'code', required: true, max: 80 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 200 },
      { api: 'settlementType', column: 'settlement_type', kind: 'enum', required: true, enumValues: ['QUANTITY', 'TIME'] },
      { api: 'lotRequired', column: 'lot_required', kind: 'bool', required: false, defaultValue: false },
      active,
    ],
  },
  'work-types': {
    type: 'work-types',
    schemaName: 'WorkTypeWrite',
    table: 'work_types',
    label: '作業種',
    orderBy: 'product_id ASC, code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'productId', column: 'product_id', kind: 'uuid', required: true, parent: productRef },
      { api: 'code', column: 'code', kind: 'code', required: true, max: 50 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 200 },
      active,
    ],
  },
  defects: {
    type: 'defects',
    schemaName: 'DefectTypeWrite',
    table: 'defect_types',
    label: '不良種',
    orderBy: 'product_id ASC, sort_order ASC, code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'productId', column: 'product_id', kind: 'uuid', required: true, parent: productRef },
      { api: 'code', column: 'code', kind: 'code', required: true, max: 50 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      { api: 'sortOrder', column: 'sort_order', kind: 'int', required: true, min: 0 },
      active,
    ],
  },
  holidays: {
    type: 'holidays',
    schemaName: 'HolidayWrite',
    table: 'holidays',
    label: '休日',
    orderBy: 'holiday_date ASC',
    retroactive: 'HOLIDAY',
    range: { fromApi: 'holidayDate', toApi: 'holidayDate' },
    uniqueField: 'holidayDate',
    fields: [
      { api: 'holidayDate', column: 'holiday_date', kind: 'date', required: true },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      active,
    ],
  },
  rates: {
    type: 'rates',
    schemaName: 'RateRuleWrite',
    table: 'rate_rules',
    label: '作業単価',
    orderBy: 'product_id ASC, valid_from DESC, id ASC',
    retroactive: 'RULE',
    range: { fromApi: 'validFrom', toApi: 'validTo' },
    uniqueField: 'validFrom',
    fields: [
      { api: 'productId', column: 'product_id', kind: 'uuid', required: true, parent: productRef },
      { api: 'workTypeId', column: 'work_type_id', kind: 'uuidNullable', required: false, parent: workTypeRef },
      { api: 'unitPrice', column: 'unit_price', kind: 'decimal14_4', required: true },
      { api: 'overtimeMultiplier', column: 'overtime_multiplier', kind: 'decimal4_4', required: false, defaultValue: '1.25' },
      { api: 'validFrom', column: 'valid_from', kind: 'date', required: true },
      { api: 'validTo', column: 'valid_to', kind: 'dateNullable', required: false },
      active,
    ],
  },
  'transport-rules': {
    type: 'transport-rules',
    schemaName: 'TransportRuleWrite',
    table: 'transport_rules',
    label: '運搬',
    orderBy: 'product_id ASC, valid_from DESC, id ASC',
    retroactive: 'RULE',
    range: { fromApi: 'validFrom', toApi: 'validTo' },
    uniqueField: 'validFrom',
    fields: [
      { api: 'productId', column: 'product_id', kind: 'uuid', required: true, parent: productRef },
      { api: 'workTypeId', column: 'work_type_id', kind: 'uuidNullable', required: false, parent: workTypeRef },
      { api: 'transportType', column: 'type', kind: 'enum', required: true, enumValues: ['ALLOCATED', 'PER_TRIP', 'MONTHLY_FIXED', 'NONE'] },
      { api: 'amountYen', column: 'amount_yen', kind: 'yen', required: true },
      { api: 'allocationGroup', column: 'allocation_group', kind: 'textNullable', required: false, max: 50 },
      { api: 'validFrom', column: 'valid_from', kind: 'date', required: true },
      { api: 'validTo', column: 'valid_to', kind: 'dateNullable', required: false },
      active,
    ],
  },
  'fixed-charges': {
    type: 'fixed-charges',
    schemaName: 'FixedChargeWrite',
    table: 'fixed_charge_rules',
    label: '固定費',
    orderBy: 'product_id ASC, valid_from DESC, id ASC',
    retroactive: 'RULE',
    range: { fromApi: 'validFrom', toApi: 'validTo' },
    uniqueField: 'validFrom',
    fields: [
      { api: 'productId', column: 'product_id', kind: 'uuid', required: true, parent: productRef },
      { api: 'label', column: 'label', kind: 'text', required: true, max: 200 },
      { api: 'amountYen', column: 'amount_yen', kind: 'yen', required: true },
      { api: 'validFrom', column: 'valid_from', kind: 'date', required: true },
      { api: 'validTo', column: 'valid_to', kind: 'dateNullable', required: false },
      active,
    ],
  },
  vehicles: {
    type: 'vehicles',
    schemaName: 'VehicleWrite',
    table: 'vehicles',
    label: '車両',
    orderBy: 'code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'code', column: 'code', kind: 'code', required: true, max: 30 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      active,
    ],
  },
  'work-locations': {
    type: 'work-locations',
    schemaName: 'WorkLocationWrite',
    table: 'work_locations',
    label: '作業場所',
    orderBy: 'code ASC, id ASC',
    retroactive: 'NONE',
    uniqueField: 'code',
    fields: [
      { api: 'code', column: 'code', kind: 'code', required: true, max: 30 },
      { api: 'name', column: 'name', kind: 'text', required: true, max: 100 },
      active,
    ],
  },
};
