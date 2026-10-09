/**
 * G2 マスタ管理サービス（FR-008 / REQ-MST-001 / CHG-001）。CHG-006: Firestore 版。
 *  - 作成/更新/無効化はすべて1 transaction: 対象を読む → expectedVersion照合 → 参照・一意キーの確認 → 更新(version+1) → audit
 *  - 一意（PostgreSQL の UNIQUE）: uniqueKeys（種類＝マスタ種別、範囲＝親ID）を同じ transaction で確保・付替え
 *  - 参照保護: 物理削除なし（無効化のみ）、親参照は作成後変更不可、無効な親への新規参照は 422 MASTER_INACTIVE
 *  - 遡及（CHG-001 D7）: 休日の過去日に掛かる更新・無効化は reason 必須、audit に retroactive を記録
 *  - preview=true: 書込まず MasterImpact を返す（REQ-MST-001 遡及影響preview）
 *  - CHG-006 F1: 請求専用マスタ（単価・運搬・固定費ルール）は移行しない（Blind）。API は 404
 */
import { randomUUID } from 'node:crypto';
import { isRetroactiveChange, jstBusinessDate, type DateRange } from '@inspexor/domain';
import { appendAudit, C, claimUnique, readUniqueOwner, releaseUnique, type DocReader, type DocStore, type DocTransaction } from '@inspexor/docstore';
import { MASTER_DEFS, type FieldDef, type MasterDef, type MasterType } from './definitions';
import type { MasterInput } from './schemas';

export class MasterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: ReadonlyArray<{ path: string; code: string; message: string }>,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface MasterRecord {
  readonly id: string;
  readonly version: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly [field: string]: unknown;
}

export interface MasterImpact {
  readonly retroactive: boolean;
  readonly affectedRecordCount: number;
  readonly affectedOpenBillingRunCount: number;
  readonly finalizedBillingUnaffected: true;
  readonly referencedBy: readonly string[];
}

export interface MasterContext {
  readonly actorId: string;
  readonly correlationId: string;
  readonly now: Date;
}

/** Firestore の文書（API 項目名のまま保存。日時は Date） */
type MasterDoc = Record<string, unknown> & { version: number; active: boolean; createdAt: Date; updatedAt: Date };

const UNIQUE_KIND = (def: MasterDef): string => `master:${def.type}`;
const linkFields = (def: MasterDef) => def.fields.filter((f) => f.kind === 'uuidArray');

function toRecord(def: MasterDef, id: string, doc: MasterDoc): MasterRecord {
  const record: Record<string, unknown> = {
    id,
    version: doc.version,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  for (const f of def.fields) {
    if (f.api === 'active') continue;
    const v = doc[f.api];
    record[f.api] = f.kind === 'uuidArray' ? [...((v as string[] | undefined) ?? [])].sort() : v ?? null;
  }
  return record as MasterRecord;
}

function fieldsOf(def: MasterDef, input: MasterInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = input[f.api];
    out[f.api] = f.kind === 'uuidArray' ? [...((v as string[] | undefined) ?? [])] : v ?? null;
  }
  return out;
}

function rangeOf(def: MasterDef, source: Record<string, unknown>): DateRange | null {
  if (def.range === undefined) return null;
  const from = source[def.range.fromApi];
  if (typeof from !== 'string') return null;
  const to = def.range.toApi === null ? null : (source[def.range.toApi] as string | null | undefined) ?? null;
  return { from, to };
}

function notFound(def: MasterDef): MasterError {
  // GAP-014: 404 に対応する error code が辞書（17件）に無いため VALIDATION_ERROR + fields で表現
  return new MasterError(404, 'VALIDATION_ERROR', `${def.label}が見つかりません。`, [
    { path: '/id', code: 'not_found', message: `${def.label}が見つかりません。` },
  ]);
}

function duplicate(def: MasterDef): MasterError {
  return new MasterError(422, 'VALIDATION_ERROR', '既に登録されています。', [
    { path: `/${def.uniqueField}`, code: 'duplicate', message: `${def.label}が既に登録されています。` },
  ]);
}

function defOf(type: MasterType): MasterDef {
  const def = MASTER_DEFS[type];
  if (def.blind === true) {
    // CHG-006 F1: 請求専用マスタは提案書の対象外（Blind）。未定義の種別と同じく 404
    throw new MasterError(404, 'VALIDATION_ERROR', 'マスタ種別が見つかりません。', [{ path: '/type', code: 'not_found', message: '未定義のマスタ種別です。' }]);
  }
  return def;
}

function versionConflict(current: MasterRecord, input: MasterInput): MasterError {
  const changedFields = Object.keys(input)
    .filter((k) => k !== 'expectedVersion' && k !== 'reason' && k in current)
    .filter((k) => JSON.stringify(current[k]) !== JSON.stringify(input[k]))
    .map((k) => `/${k}`);
  return new MasterError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], {
    currentVersion: current.version,
    changedFields,
  });
}

function uniqueScopeOf(def: MasterDef, source: Record<string, unknown>): string {
  return def.uniqueScope === null ? '-' : String(source[def.uniqueScope]);
}

/** 親参照の存在・有効性・整合性（参照保護）。transaction の読込段階で呼ぶ */
async function checkReferences(db: DocReader, def: MasterDef, input: MasterInput, onlyChanged?: MasterRecord): Promise<void> {
  for (const f of def.fields) {
    if (f.parent === undefined) continue;
    const value = input[f.api];
    if (value === null || value === undefined) continue;
    if (onlyChanged !== undefined && onlyChanged[f.api] === value && onlyChanged.active === true) continue;
    const parent = await db.get<{ active: boolean }>(`${f.parent.collection}/${String(value)}`);
    if (parent === null) {
      throw new MasterError(422, 'VALIDATION_ERROR', `${f.parent.label}が存在しません。`, [
        { path: `/${f.api}`, code: 'not_found', message: `${f.parent.label}が存在しません。` },
      ]);
    }
    if (!parent.active) {
      throw new MasterError(422, 'MASTER_INACTIVE', `${f.parent.label}は無効化されています。`, [
        { path: `/${f.api}`, code: 'inactive', message: `${f.parent.label}は無効化されています。` },
      ]);
    }
  }
  // 担当品番は同一顧客の有効な品番であること
  for (const f of linkFields(def)) {
    const ids = (input[f.api] as string[] | undefined) ?? [];
    const products = await db.getMany<{ customerId: string; active: boolean }>(ids.map((id) => `${C.products}/${id}`));
    for (const [i, p] of products.entries()) {
      if (p === null || p.customerId !== input['customerId']) {
        throw new MasterError(422, 'VALIDATION_ERROR', '担当品番が顧客に属していません。', [
          { path: `/${f.api}/${i}`, code: 'mismatch', message: '担当品番が顧客に属していません。' },
        ]);
      }
      if (!p.active) {
        throw new MasterError(422, 'MASTER_INACTIVE', '担当品番は無効化されています。', [
          { path: `/${f.api}/${i}`, code: 'inactive', message: '担当品番は無効化されています。' },
        ]);
      }
    }
  }
}

function assertParentsUnchanged(def: MasterDef, current: MasterRecord, input: MasterInput): void {
  const changed = def.fields.filter((f) => f.parent !== undefined && f.kind === 'uuid' && current[f.api] !== input[f.api]);
  if (changed.length > 0) {
    throw new MasterError(
      422,
      'VALIDATION_ERROR',
      '所属（顧客・品番）は変更できません。新規に登録してください。',
      changed.map((f) => ({ path: `/${f.api}`, code: 'immutable', message: '作成後は変更できません。' })),
    );
  }
}

async function countWhere(db: DocReader, collection: string, field: string, op: '==' | 'array-contains', value: string, activeOnly = false): Promise<number> {
  const rows = await db.query<{ active?: boolean }>(collection, { where: [{ field, op, value }] });
  return activeOnly ? rows.filter((r) => r.data.active === true).length : rows.length;
}

/**
 * 影響 preview。CHG-006: 実績の参照数は報告ヘッダの要約（最新の版の品番・作業者・車両・作業場所・不良種）で数える。
 * 休日の遡及は確定済みの現在版の業務日（current.businessDate）で数える。請求 run は Blind のため常に 0。
 */
async function computeImpact(db: DocReader, def: MasterDef, record: MasterRecord | null, before: DateRange | null, after: DateRange | null, today: string): Promise<MasterImpact> {
  const retroactive = isRetroactiveChange(def.retroactive, before, after, today);
  let affectedRecordCount = 0;
  const referencedBy: string[] = [];

  if (def.retroactive === 'HOLIDAY') {
    const dates = [...new Set([before?.from, after?.from].filter((d): d is string => typeof d === 'string' && d < today))];
    if (dates.length > 0) {
      const rows = await db.query(C.workReports, { where: [{ field: 'current.businessDate', op: 'in', value: dates }] });
      affectedRecordCount = rows.length;
    }
  }

  if (record !== null) {
    const id = record.id;
    const refs: Partial<Record<MasterType, Array<[string, () => Promise<number>]>>> = {
      customers: [
        ['products', () => countWhere(db, C.products, 'customerId', '==', id, true)],
        ['contacts', () => countWhere(db, C.customerContacts, 'customerId', '==', id, true)],
      ],
      products: [
        ['workTypes', () => countWhere(db, C.workTypes, 'productId', '==', id, true)],
        ['defects', () => countWhere(db, C.defectTypes, 'productId', '==', id, true)],
        ['workRevisions', () => countWhere(db, C.workReports, 'productIds', 'array-contains', id)],
      ],
      workers: [['workRevisions', () => countWhere(db, C.workReports, 'workerIds', 'array-contains', id)]],
      vehicles: [
        ['workRevisions', () => countWhere(db, C.workReports, 'vehicleId', '==', id)],
        ['deliveryRevisions', () => countWhere(db, C.deliveryReports, 'vehicleId', '==', id)],
      ],
      'work-locations': [['workRevisions', () => countWhere(db, C.workReports, 'workLocationId', '==', id)]],
      defects: [['defectResults', () => countWhere(db, C.workReports, 'defectTypeIds', 'array-contains', id)]],
      contacts: [['productLinks', async () => ((record['dailyProductIds'] as string[]) ?? []).length + ((record['invoiceProductIds'] as string[]) ?? []).length]],
    };
    for (const [label, count] of refs[def.type] ?? []) {
      const n = await count();
      if (n > 0) referencedBy.push(`${label}:${n}`);
    }
  }

  return { retroactive, affectedRecordCount, affectedOpenBillingRunCount: 0, finalizedBillingUnaffected: true, referencedBy };
}

function compareBy(def: MasterDef): (a: { id: string; data: MasterDoc }, b: { id: string; data: MasterDoc }) => number {
  return (a, b) => {
    for (const k of def.sortKeys) {
      const x = a.data[k.field] as string | number | null | undefined;
      const y = b.data[k.field] as string | number | null | undefined;
      if (x === y) continue;
      if (x === null || x === undefined) return -1;
      if (y === null || y === undefined) return 1;
      const c = x < y ? -1 : 1;
      return k.dir === 'desc' ? -c : c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

async function readCurrent(tx: DocReader, def: MasterDef, id: string): Promise<MasterRecord> {
  const doc = await tx.get<MasterDoc>(`${def.collection}/${id}`);
  if (doc === null) throw notFound(def);
  return toRecord(def, id, doc);
}

export class MasterService {
  constructor(private readonly store: DocStore) {}

  async list(type: MasterType, page: number, pageSize: number): Promise<{ data: MasterRecord[]; meta: { page: number; pageSize: number; total: number } }> {
    const def = defOf(type);
    // マスタは数百件規模のため全件を読み、アプリで並べ替える（複合索引を増やさない）
    const rows = await this.store.query<MasterDoc>(def.collection);
    rows.sort(compareBy(def));
    const start = (page - 1) * pageSize;
    return {
      data: rows.slice(start, start + pageSize).map((r) => toRecord(def, r.id, r.data)),
      meta: { page, pageSize, total: rows.length },
    };
  }

  async get(type: MasterType, id: string): Promise<MasterRecord> {
    const def = defOf(type);
    return readCurrent(this.store, def, id);
  }

  async create(type: MasterType, input: MasterInput, ctx: MasterContext): Promise<MasterRecord> {
    const def = defOf(type);
    const id = randomUUID();
    return this.store.runTransaction(async (tx) => {
      await checkReferences(tx, def, input);
      const scope = uniqueScopeOf(def, input);
      const uniqueValue = String(input[def.uniqueField]);
      if ((await readUniqueOwner(tx, UNIQUE_KIND(def), scope, uniqueValue)) !== null) throw duplicate(def);
      const doc: MasterDoc = { ...fieldsOf(def, input), version: 1, active: (input['active'] as boolean | undefined) ?? true, createdAt: ctx.now, updatedAt: ctx.now };
      const created = toRecord(def, id, doc);
      const retroactive = isRetroactiveChange(def.retroactive, null, rangeOf(def, created), jstBusinessDate(ctx.now));
      claimUnique(tx, UNIQUE_KIND(def), scope, uniqueValue, id);
      tx.create(`${def.collection}/${id}`, doc);
      appendAudit(tx, { actorId: ctx.actorId, action: 'MASTER_CREATE', targetType: `MASTER:${type}`, targetId: id, afterData: { record: created, retroactive }, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
      return created;
    });
  }

  async update(
    type: MasterType,
    id: string,
    input: MasterInput,
    ctx: MasterContext,
    preview: boolean,
  ): Promise<{ kind: 'record'; record: MasterRecord } | { kind: 'impact'; impact: MasterImpact }> {
    const def = defOf(type);
    return this.store.runTransaction(async (tx) => {
      const current = await readCurrent(tx, def, id);
      if (current.version !== input['expectedVersion']) throw versionConflict(current, input);
      assertParentsUnchanged(def, current, input);
      const today = jstBusinessDate(ctx.now);
      const before = rangeOf(def, current);
      const after = rangeOf(def, input);
      if (preview) {
        return { kind: 'impact' as const, impact: await computeImpact(tx, def, current, before, after, today) };
      }
      await checkReferences(tx, def, input, current);
      const scope = uniqueScopeOf(def, current);
      const oldValue = String(current[def.uniqueField]);
      const newValue = String(input[def.uniqueField]);
      const keyChanged = oldValue !== newValue;
      if (keyChanged) {
        const owner = await readUniqueOwner(tx, UNIQUE_KIND(def), scope, newValue);
        if (owner !== null && owner !== id) throw duplicate(def);
      }
      const doc: MasterDoc = {
        ...fieldsOf(def, input),
        active: (input['active'] as boolean | undefined) ?? current.active,
        version: current.version + 1,
        createdAt: new Date(current.createdAt),
        updatedAt: ctx.now,
      };
      const updated = toRecord(def, id, doc);
      const retroactive = isRetroactiveChange(def.retroactive, before, after, today);
      if (keyChanged) {
        releaseUnique(tx, UNIQUE_KIND(def), scope, oldValue);
        claimUnique(tx, UNIQUE_KIND(def), scope, newValue, id);
      }
      tx.set(`${def.collection}/${id}`, doc);
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'MASTER_UPDATE',
          targetType: `MASTER:${type}`,
          targetId: id,
          beforeData: { record: current },
          afterData: { record: updated, retroactive },
          reason: input['reason'] as string,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { kind: 'record' as const, record: updated };
    });
  }

  async deactivate(
    type: MasterType,
    id: string,
    command: { expectedVersion: number; reason?: string | undefined },
    ctx: MasterContext,
    preview: boolean,
  ): Promise<{ kind: 'done' } | { kind: 'impact'; impact: MasterImpact }> {
    const def = defOf(type);
    return this.store.runTransaction(async (tx: DocTransaction) => {
      const current = await readCurrent(tx, def, id);
      if (current.version !== command.expectedVersion) {
        throw new MasterError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], {
          currentVersion: current.version,
          changedFields: [],
        });
      }
      if (!current.active) {
        throw new MasterError(409, 'STATE_CONFLICT', `${def.label}は既に無効化されています。`, [], { currentVersion: current.version });
      }
      const today = jstBusinessDate(ctx.now);
      const before = rangeOf(def, current);
      if (preview) {
        return { kind: 'impact' as const, impact: await computeImpact(tx, def, current, before, null, today) };
      }
      const retroactive = isRetroactiveChange(def.retroactive, before, null, today);
      const reason = command.reason?.trim() ?? '';
      if (retroactive && reason.length === 0) {
        throw new MasterError(422, 'VALIDATION_ERROR', '過去期間に掛かる無効化は理由が必須です。', [
          { path: '/reason', code: 'required', message: '過去期間に掛かる無効化は理由が必須です。' },
        ]);
      }
      tx.update(`${def.collection}/${id}`, { active: false, version: current.version + 1, updatedAt: ctx.now });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'MASTER_DEACTIVATE',
          targetType: `MASTER:${type}`,
          targetId: id,
          beforeData: { record: current },
          afterData: { active: false, version: current.version + 1, retroactive },
          ...(reason.length > 0 ? { reason } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { kind: 'done' as const };
    });
  }
}

/** 試験・seed 用: FieldDef の参照（型の再輸出） */
export type { FieldDef };
