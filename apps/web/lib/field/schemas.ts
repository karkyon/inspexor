/**
 * G3 現場入力の Zod schema（openapi WorkDraft / WorkUpdate / DeliveryDraft / DeliveryUpdate と同値、CHG-002）。
 * contract test（field-schema-contract.test.ts）で openapi と受理/拒否を照合する。
 * 画面の上限（作業者50名・数量999999 等）は openapi に無いため domain の業務検証（422）で適用する。
 */
import { z } from 'zod';

// ajv-formats の uuid / date / date-time と同じ判定（Zod 3/4 差異を避けるため自前 regex）
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isDateTime(value: string): boolean {
  return DATE_TIME_RE.test(value) && isCalendarDate(value.slice(0, 10)) && !Number.isNaN(new Date(value).getTime());
}

const uuid = () => z.string().regex(UUID_RE, 'uuid形式ではありません');
const date = () => z.string().refine(isCalendarDate, 'YYYY-MM-DD形式の日付ではありません');
const dateTime = () => z.string().refine(isDateTime, '日時の形式が正しくありません');
const expectedVersion = () => z.number().int().min(1);

export const defectSchema = z.object({ defectTypeId: uuid(), quantity: z.number().int().min(0) }).strict();

const workShape = {
  workDate: date(),
  reporterId: uuid(),
  customerId: uuid(),
  productId: uuid(),
  workTypeId: uuid(),
  // 文字列は trim（API設計書）。空文字は「ロットなし」= null として扱う
  lotNo: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      const t = v.trim();
      return t === '' ? null : t;
    }),
  workerIds: z
    .array(uuid())
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, '作業者が重複しています'),
  startAt: dateTime(),
  endAt: dateTime(),
  quantity: z.number().int().min(0),
  defects: z.array(defectSchema),
};

export const workDraftSchema = z.object(workShape).strict();
export const workUpdateSchema = z.object({ ...workShape, expectedVersion: expectedVersion() }).strict();

export const deliveryItemSchema = z.object({ productId: uuid(), quantity: z.number().int().min(1) }).strict();

const deliveryShape = {
  deliveryDate: date(),
  driverId: uuid(),
  customerId: uuid(),
  items: z.array(deliveryItemSchema).min(1),
};

export const deliveryDraftSchema = z.object(deliveryShape).strict();
export const deliveryUpdateSchema = z.object({ ...deliveryShape, expectedVersion: expectedVersion() }).strict();

export const fieldCommandSchema = z
  .object({
    expectedVersion: expectedVersion(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

export type WorkDraftInput = z.infer<typeof workDraftSchema>;
export type DeliveryDraftInput = z.infer<typeof deliveryDraftSchema>;
