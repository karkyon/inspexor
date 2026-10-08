/**
 * G2 マスタ管理サービス（FR-008 / REQ-MST-001 / CHG-001）。
 *  - 作成/更新/無効化はすべて1 transaction: root `SELECT FOR UPDATE` → expectedVersion照合 → 更新(version+1) → audit
 *  - 参照保護: 物理削除なし（無効化のみ）、親参照は作成後変更不可、無効な親への新規参照は 422 MASTER_INACTIVE
 *  - 遡及（CHG-001 D7）: rule/休日の過去期間に掛かる更新・無効化は reason 必須、audit に retroactive を記録
 *  - preview=true: 書込まず MasterImpact を返す（REQ-MST-001 遡及影響preview）
 */
import type { Pool, PoolClient } from 'pg';
import { isRetroactiveChange, jstBusinessDate, unionRange, type DateRange } from '@inspexor/domain';
import { withTransaction, type Queryable } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
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

const OPEN_BILLING_STATUSES = ['OPEN', 'CALCULATING', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED'];

const scalarFields = (def: MasterDef) => def.fields.filter((f) => f.kind !== 'uuidArray');
const linkFields = (def: MasterDef) => def.fields.filter((f) => f.kind === 'uuidArray');

function selectSql(def: MasterDef): string {
  const cols = scalarFields(def).map((f) => `t.${f.column}`);
  const links = linkFields(def).map(
    (f) =>
      `ARRAY(SELECT pc.product_id::text FROM app.product_contacts pc WHERE pc.contact_id = t.id AND pc.purpose = '${f.column}' ORDER BY pc.product_id) AS "${f.api}"`,
  );
  return `SELECT t.id, t.version, t.active, t.created_at, t.updated_at, ${[...cols, ...links].join(', ')} FROM app.${def.table} t`;
}

function toApiValue(f: FieldDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (f.kind === 'yen') {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error(`unsafe integer in ${f.column}`);
    return n;
  }
  return value;
}

function rowToRecord(def: MasterDef, row: Record<string, unknown>): MasterRecord {
  const record: Record<string, unknown> = {
    id: row['id'],
    version: row['version'],
    active: row['active'],
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
  for (const f of scalarFields(def)) {
    if (f.api === 'active') continue;
    record[f.api] = toApiValue(f, row[f.column]);
  }
  for (const f of linkFields(def)) record[f.api] = row[f.api] ?? [];
  return record as MasterRecord;
}

function rangeOf(def: MasterDef, source: Record<string, unknown>): DateRange | null {
  if (def.range === undefined) return null;
  const from = source[def.range.fromApi];
  if (typeof from !== 'string') return null;
  const to = def.range.toApi === null ? null : (source[def.range.toApi] as string | null | undefined) ?? null;
  return { from, to };
}

function mapDbError(def: MasterDef, error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '23505') {
    throw new MasterError(422, 'VALIDATION_ERROR', '既に登録されています。', [
      { path: `/${def.uniqueField}`, code: 'duplicate', message: `${def.label}が既に登録されています。` },
    ]);
  }
  if (code === '23P01') {
    throw new MasterError(422, 'VALIDATION_ERROR', '適用期間が既存の有効なルールと重複しています。', [
      { path: '/validFrom', code: 'overlap', message: '適用期間が既存の有効なルールと重複しています。' },
    ]);
  }
  if (code === '23514') {
    throw new MasterError(422, 'VALIDATION_ERROR', '入力値が制約に違反しています。', [
      { path: '/', code: 'check', message: '入力値が制約に違反しています。' },
    ]);
  }
  if (code === '23503') {
    throw new MasterError(422, 'VALIDATION_ERROR', '参照先が存在しません。', [
      { path: '/', code: 'not_found', message: '参照先が存在しません。' },
    ]);
  }
  throw error;
}

async function lockRow(client: PoolClient, def: MasterDef, id: string): Promise<Record<string, unknown>> {
  const result = await client.query(`${selectSql(def)} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound(def);
  return row;
}

function notFound(def: MasterDef): MasterError {
  // GAP-014: 404 に対応する error code が辞書（17件）に無いため VALIDATION_ERROR + fields で表現
  return new MasterError(404, 'VALIDATION_ERROR', `${def.label}が見つかりません。`, [
    { path: '/id', code: 'not_found', message: `${def.label}が見つかりません。` },
  ]);
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

/** 親参照の存在・有効性・整合性（参照保護） */
async function checkReferences(db: Queryable, def: MasterDef, input: MasterInput, onlyChanged?: MasterRecord): Promise<void> {
  for (const f of def.fields) {
    if (f.parent === undefined) continue;
    const value = input[f.api];
    if (value === null || value === undefined) continue;
    if (onlyChanged !== undefined && onlyChanged[f.api] === value && onlyChanged.active === true) continue;
    const r = await db.query<{ active: boolean }>(`SELECT active FROM app.${f.parent.table} WHERE id = $1`, [value]);
    const parent = r.rows[0];
    if (parent === undefined) {
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
  // 作業種は同一品番配下であること
  if (input['workTypeId'] && input['productId']) {
    const r = await db.query<{ product_id: string }>(`SELECT product_id FROM app.work_types WHERE id = $1`, [input['workTypeId']]);
    if (r.rows[0]?.product_id !== input['productId']) {
      throw new MasterError(422, 'VALIDATION_ERROR', '作業種が品番に属していません。', [
        { path: '/workTypeId', code: 'mismatch', message: '作業種が品番に属していません。' },
      ]);
    }
  }
  // 担当品番は同一顧客の有効な品番であること
  for (const f of linkFields(def)) {
    const ids = (input[f.api] as string[] | undefined) ?? [];
    for (const [i, productId] of ids.entries()) {
      const r = await db.query<{ customer_id: string; active: boolean }>(
        `SELECT customer_id, active FROM app.products WHERE id = $1`,
        [productId],
      );
      const p = r.rows[0];
      if (p === undefined || p.customer_id !== input['customerId']) {
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

async function writeLinks(client: PoolClient, def: MasterDef, id: string, input: MasterInput): Promise<void> {
  const links = linkFields(def);
  if (links.length === 0) return;
  await client.query(`DELETE FROM app.product_contacts WHERE contact_id = $1`, [id]);
  for (const f of links) {
    for (const productId of (input[f.api] as string[] | undefined) ?? []) {
      await client.query(`INSERT INTO app.product_contacts (product_id, contact_id, purpose) VALUES ($1, $2, $3)`, [
        productId,
        id,
        f.column,
      ]);
    }
  }
}

async function computeImpact(
  db: Queryable,
  def: MasterDef,
  record: MasterRecord | null,
  before: DateRange | null,
  after: DateRange | null,
  today: string,
): Promise<MasterImpact> {
  const retroactive = isRetroactiveChange(def.retroactive, before, after, today);
  let affectedRecordCount = 0;
  let affectedOpenBillingRunCount = 0;
  const referencedBy: string[] = [];
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const span = unionRange(before, after);

  if (def.retroactive === 'RULE' && span !== null && record !== null) {
    const productId = record['productId'] as string;
    const pastTo = span.to === null || span.to > yesterday ? yesterday : span.to;
    if (span.from <= pastTo) {
      if (def.type === 'rates') {
        const r = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM app.work_reports r JOIN app.work_report_revisions v ON v.id = r.current_revision_id
            WHERE v.product_id = $1 AND v.work_date BETWEEN $2 AND $3 AND r.status <> 'BILLING_LOCKED'
              AND ($4::uuid IS NULL OR v.work_type_id = $4)`,
          [productId, span.from, pastTo, record['workTypeId'] ?? null],
        );
        affectedRecordCount = Number(r.rows[0]?.n ?? 0);
      } else if (def.type === 'transport-rules') {
        const r = await db.query<{ n: string }>(
          `SELECT count(DISTINCT r.id)::text AS n FROM app.delivery_reports r
             JOIN app.delivery_report_revisions v ON v.id = r.current_revision_id
             JOIN app.delivery_items i ON i.delivery_revision_id = v.id
            WHERE i.product_id = $1 AND v.delivery_date BETWEEN $2 AND $3 AND r.status <> 'BILLING_LOCKED'`,
          [productId, span.from, pastTo],
        );
        affectedRecordCount = Number(r.rows[0]?.n ?? 0);
      }
    }
    const b = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.billing_runs b JOIN app.products p ON p.customer_id = b.customer_id
        WHERE p.id = $1 AND b.status::text = ANY($2)
          AND daterange(b.period_start, b.period_end, '[]') && daterange($3::date, COALESCE($4::date, 'infinity'::date), '[]')`,
      [productId, OPEN_BILLING_STATUSES, span.from, span.to],
    );
    affectedOpenBillingRunCount = Number(b.rows[0]?.n ?? 0);
  } else if (def.retroactive === 'HOLIDAY') {
    const dates = [before?.from, after?.from].filter((d): d is string => typeof d === 'string' && d < today);
    if (dates.length > 0) {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.work_reports r JOIN app.work_report_revisions v ON v.id = r.current_revision_id
          WHERE v.work_date = ANY($1::date[]) AND r.status <> 'BILLING_LOCKED'`,
        [dates],
      );
      affectedRecordCount = Number(r.rows[0]?.n ?? 0);
      const b = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.billing_runs b
          WHERE b.status::text = ANY($1) AND EXISTS (SELECT 1 FROM unnest($2::date[]) d WHERE d BETWEEN b.period_start AND b.period_end)`,
        [OPEN_BILLING_STATUSES, dates],
      );
      affectedOpenBillingRunCount = Number(b.rows[0]?.n ?? 0);
    }
  }

  if (record !== null) {
    const refs: Partial<Record<MasterType, Array<[string, string]>>> = {
      customers: [
        ['products', `SELECT count(*)::text AS n FROM app.products WHERE customer_id = $1 AND active`],
        ['contacts', `SELECT count(*)::text AS n FROM app.customer_contacts WHERE customer_id = $1 AND active`],
        ['billingRuns', `SELECT count(*)::text AS n FROM app.billing_runs WHERE customer_id = $1`],
      ],
      products: [
        ['workTypes', `SELECT count(*)::text AS n FROM app.work_types WHERE product_id = $1 AND active`],
        ['defects', `SELECT count(*)::text AS n FROM app.defect_types WHERE product_id = $1 AND active`],
        ['rates', `SELECT count(*)::text AS n FROM app.rate_rules WHERE product_id = $1 AND active`],
        ['workRevisions', `SELECT count(*)::text AS n FROM app.work_report_revisions WHERE product_id = $1`],
      ],
      workers: [['workRevisions', `SELECT count(*)::text AS n FROM app.work_report_workers WHERE worker_id = $1`]],
      'work-types': [['rates', `SELECT count(*)::text AS n FROM app.rate_rules WHERE work_type_id = $1 AND active`]],
      defects: [['defectResults', `SELECT count(*)::text AS n FROM app.defect_results WHERE defect_type_id = $1`]],
      contacts: [['productLinks', `SELECT count(*)::text AS n FROM app.product_contacts WHERE contact_id = $1`]],
    };
    for (const [label, sql] of refs[def.type] ?? []) {
      const r = await db.query<{ n: string }>(sql, [record.id]);
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) referencedBy.push(`${label}:${n}`);
    }
  }

  return { retroactive, affectedRecordCount, affectedOpenBillingRunCount, finalizedBillingUnaffected: true, referencedBy };
}

export class MasterService {
  constructor(private readonly pool: Pool) {}

  async list(type: MasterType, page: number, pageSize: number): Promise<{ data: MasterRecord[]; meta: { page: number; pageSize: number; total: number } }> {
    const def = MASTER_DEFS[type];
    const total = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${def.table}`);
    const rows = await this.pool.query(`${selectSql(def)} ORDER BY ${def.orderBy.replace(/(^|, )/g, '$1t.')} LIMIT $1 OFFSET $2`, [
      pageSize,
      (page - 1) * pageSize,
    ]);
    return {
      data: rows.rows.map((row) => rowToRecord(def, row as Record<string, unknown>)),
      meta: { page, pageSize, total: Number(total.rows[0]?.n ?? 0) },
    };
  }

  async get(type: MasterType, id: string): Promise<MasterRecord> {
    const def = MASTER_DEFS[type];
    const r = await this.pool.query(`${selectSql(def)} WHERE t.id = $1`, [id]);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw notFound(def);
    return rowToRecord(def, row);
  }

  async create(type: MasterType, input: MasterInput, ctx: MasterContext): Promise<MasterRecord> {
    const def = MASTER_DEFS[type];
    try {
      return await withTransaction(this.pool, async (client) => {
        await checkReferences(client, def, input);
        const fields = scalarFields(def);
        const result = await client.query<{ id: string }>(
          `INSERT INTO app.${def.table} (${fields.map((f) => f.column).join(', ')})
           VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          fields.map((f) => input[f.api] ?? null),
        );
        const id = result.rows[0]?.id as string;
        await writeLinks(client, def, id, input);
        const created = rowToRecord(def, (await client.query(`${selectSql(def)} WHERE t.id = $1`, [id])).rows[0] as Record<string, unknown>);
        const retroactive = isRetroactiveChange(def.retroactive, null, rangeOf(def, created), jstBusinessDate(ctx.now));
        await new PgAuditRepository(client).append({
          actorId: ctx.actorId,
          action: 'MASTER_CREATE',
          targetType: `MASTER:${type}`,
          targetId: id,
          afterData: { record: created, retroactive },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        });
        return created;
      });
    } catch (error) {
      if (error instanceof MasterError) throw error;
      return mapDbError(def, error);
    }
  }

  async update(
    type: MasterType,
    id: string,
    input: MasterInput,
    ctx: MasterContext,
    preview: boolean,
  ): Promise<{ kind: 'record'; record: MasterRecord } | { kind: 'impact'; impact: MasterImpact }> {
    const def = MASTER_DEFS[type];
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = rowToRecord(def, await lockRow(client, def, id));
        if (current.version !== input['expectedVersion']) throw versionConflict(current, input);
        assertParentsUnchanged(def, current, input);
        const today = jstBusinessDate(ctx.now);
        const before = rangeOf(def, current);
        const after = rangeOf(def, input);
        if (preview) {
          return { kind: 'impact' as const, impact: await computeImpact(client, def, current, before, after, today) };
        }
        await checkReferences(client, def, input, current);
        const fields = scalarFields(def);
        await client.query(
          `UPDATE app.${def.table} SET ${fields.map((f, i) => `${f.column} = $${i + 2}`).join(', ')},
                  version = version + 1, updated_at = now() WHERE id = $1`,
          [id, ...fields.map((f) => input[f.api] ?? null)],
        );
        await writeLinks(client, def, id, input);
        const updated = rowToRecord(def, (await client.query(`${selectSql(def)} WHERE t.id = $1`, [id])).rows[0] as Record<string, unknown>);
        const retroactive = isRetroactiveChange(def.retroactive, before, after, today);
        await new PgAuditRepository(client).append({
          actorId: ctx.actorId,
          action: 'MASTER_UPDATE',
          targetType: `MASTER:${type}`,
          targetId: id,
          beforeData: { record: current },
          afterData: { record: updated, retroactive },
          reason: input['reason'] as string,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        });
        return { kind: 'record' as const, record: updated };
      });
    } catch (error) {
      if (error instanceof MasterError) throw error;
      return mapDbError(def, error);
    }
  }

  async deactivate(
    type: MasterType,
    id: string,
    command: { expectedVersion: number; reason?: string | undefined },
    ctx: MasterContext,
    preview: boolean,
  ): Promise<{ kind: 'done' } | { kind: 'impact'; impact: MasterImpact }> {
    const def = MASTER_DEFS[type];
    return withTransaction(this.pool, async (client) => {
      const current = rowToRecord(def, await lockRow(client, def, id));
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
        return { kind: 'impact' as const, impact: await computeImpact(client, def, current, before, null, today) };
      }
      const retroactive = isRetroactiveChange(def.retroactive, before, null, today);
      const reason = command.reason?.trim() ?? '';
      if (retroactive && reason.length === 0) {
        throw new MasterError(422, 'VALIDATION_ERROR', '過去期間に掛かる無効化は理由が必須です。', [
          { path: '/reason', code: 'required', message: '過去期間に掛かる無効化は理由が必須です。' },
        ]);
      }
      await client.query(`UPDATE app.${def.table} SET active = false, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await new PgAuditRepository(client).append({
        actorId: ctx.actorId,
        action: 'MASTER_DEACTIVATE',
        targetType: `MASTER:${type}`,
        targetId: id,
        beforeData: { record: current },
        afterData: { active: false, version: current.version + 1, retroactive },
        ...(reason.length > 0 ? { reason } : {}),
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { kind: 'done' as const };
    });
  }
}
