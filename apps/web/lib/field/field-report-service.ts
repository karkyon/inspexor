/**
 * G3 現場入力サービス（FR-002 運搬 / FR-003 作業 / FR-004 revision / CHG-002）。
 *
 * command pipeline（機能別詳細設計書）: transaction → root FOR UPDATE → expectedVersion → owner/scope → state guard
 *   → domain invariant（master 有効性・関係・時間・数量） → revision/audit/outbox → version+1 → commit。
 *
 *  - 作成（API-004/008）: header（DRAFT）＋未確定 revision（confirmed_at NULL）。報告番号は作成日JSTの月で採番（CHG-002 §2.3）
 *  - 更新（API-006/010）: DRAFT の未確定 revision を置換（作業者・不良・明細は削除→再作成）
 *  - 確定（API-007/011）: master/関係/時間/数量を再検証 → revision.confirmed_at（以後 DB trigger で不変）
 *                         → current_revision_id → CONFIRMED → outbox（WorkReportConfirmed / DeliveryReportConfirmed）
 *  - 参照（API-005/009）: owner か OFFICE/ADMIN/AUDITOR のみ。それ以外は存在を秘匿して 404
 *  - 報告者は本人のみ（SPEC-CONFLICT-G3-01: 代理入力は別CHG）
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  computeBusinessTime,
  nextReportNo,
  reportMonthOf,
  validateDeliveryItems,
  validateWorkQuantities,
  validateWorkSpan,
  type FieldIssue,
  type ReportKind,
} from '@inspexor/domain';
import type { OutboxEventType } from '@inspexor/application';
import { withTransaction, type Queryable } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { PgOutboxRepository } from '../db/pg-outbox-repository';
import type { DeliveryDraftInput, WorkDraftInput } from './schemas';

export type FieldReportType = 'WORK' | 'DELIVERY';

export class FieldError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: readonly FieldIssue[],
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface FieldActor {
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface FieldContext {
  readonly actor: FieldActor;
  readonly correlationId: string;
  readonly now: Date;
}

export interface RecordSummary {
  readonly id: string;
  readonly reportNo: string;
  readonly status: string;
  readonly version: number;
  readonly documentStatus: string | null;
  readonly type: FieldReportType;
  readonly businessDate: string;
  readonly revisionNo: number;
}

interface HeaderRow {
  id: string;
  report_no: string;
  status: string;
  owner_id: string;
  version: number;
  current_revision_id: string | null;
}

const KIND: Record<FieldReportType, ReportKind> = { WORK: 'WR', DELIVERY: 'DR' };
const TABLES = {
  WORK: { header: 'work_reports', revision: 'work_report_revisions', dateColumn: 'work_date', label: '作業日報', target: 'WORK_REPORT' },
  DELIVERY: { header: 'delivery_reports', revision: 'delivery_report_revisions', dateColumn: 'delivery_date', label: '運搬実績', target: 'DELIVERY_REPORT' },
} as const;
const READ_ALL_ROLES = ['OFFICE', 'ADMIN', 'AUDITOR'];

function notFound(type: FieldReportType): FieldError {
  // GAP-014: 404 に対応する error code が辞書に無いため VALIDATION_ERROR + /id（G2 と同じ扱い）
  return new FieldError(404, 'VALIDATION_ERROR', `${TABLES[type].label}が見つかりません。`, [
    { path: '/id', code: 'not_found', message: `${TABLES[type].label}が見つかりません。` },
  ]);
}

function invalid(issues: readonly FieldIssue[]): FieldError {
  return new FieldError(422, 'VALIDATION_ERROR', '入力内容を確認してください。', issues);
}

function canReadAll(actor: FieldActor): boolean {
  return actor.roles.some((r) => READ_ALL_ROLES.includes(r));
}

/** OFFICE（owner/OFFICE型の対象ロール）以外は所有者のみ更新可 */
function canWrite(actor: FieldActor, header: HeaderRow): boolean {
  return actor.roles.includes('OFFICE') || header.owner_id === actor.userId;
}

async function lockHeader(client: Queryable, type: FieldReportType, id: string): Promise<HeaderRow | null> {
  const r = await client.query<HeaderRow>(
    `SELECT id, report_no, status, owner_id, version, current_revision_id FROM app.${TABLES[type].header} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function allocateReportNo(client: Queryable, type: FieldReportType, now: Date): Promise<string> {
  const kind = KIND[type];
  const month = reportMonthOf(now);
  // 同月・同種の採番を直列化（transaction 終了で解放）
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inspexor:report_no:${kind}:${month}`]);
  const r = await client.query<{ max: string | null }>(
    `SELECT max(report_no) AS max FROM app.${TABLES[type].header} WHERE report_no LIKE $1`,
    [`${kind}-${month}-%`],
  );
  return nextReportNo(kind, now, r.rows[0]?.max ?? null);
}

// ------------------------------------------------------------------ master 検証

interface WorkComputed {
  readonly breakMinutes: number;
  readonly regularMinutes: number;
  readonly overtimeMinutes: number;
  readonly regularPersonMinutes: number;
  readonly overtimePersonMinutes: number;
}

interface MasterRow {
  id: string;
  active: boolean;
  customer_id?: string;
  product_id?: string;
  lot_required?: boolean;
}

async function rowsById(db: Queryable, table: string, ids: readonly string[], extra = ''): Promise<Map<string, MasterRow>> {
  if (ids.length === 0) return new Map();
  const r = await db.query<MasterRow>(`SELECT id, active${extra} FROM app.${table} WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
  return new Map(r.rows.map((row) => [row.id, row]));
}

function checkActive(issues: FieldIssue[], row: MasterRow | undefined, path: string, label: string): row is MasterRow {
  if (row === undefined) {
    issues.push({ path, code: 'not_found', message: `${label}が見つかりません。` });
    return false;
  }
  if (!row.active) {
    issues.push({ path, code: 'inactive', message: `${label}は無効化されています。` });
    return false;
  }
  return true;
}

/** expectedReporterId: 作成時=本人、更新・確定時=下書きの報告者（OFFICE が他人の下書きを直しても報告者は変えない） */
async function validateWork(db: Queryable, input: WorkDraftInput, expectedReporterId: string): Promise<WorkComputed> {
  const issues: FieldIssue[] = [];
  if (input.reporterId !== expectedReporterId) {
    issues.push({ path: '/reporterId', code: 'proxy_unsupported', message: '報告者はログイン中の本人を指定してください（代理入力は未対応です）。' });
  }
  const customers = await rowsById(db, 'customers', [input.customerId]);
  checkActive(issues, customers.get(input.customerId), '/customerId', 'お客様');
  const products = await rowsById(db, 'products', [input.productId], ', customer_id, lot_required');
  const product = products.get(input.productId);
  if (checkActive(issues, product, '/productId', '品番') && product.customer_id !== input.customerId) {
    issues.push({ path: '/productId', code: 'mismatch', message: '品番が選択したお客様のものではありません。' });
  }
  const workTypes = await rowsById(db, 'work_types', [input.workTypeId], ', product_id');
  const workType = workTypes.get(input.workTypeId);
  if (checkActive(issues, workType, '/workTypeId', '作業内容') && workType.product_id !== input.productId) {
    issues.push({ path: '/workTypeId', code: 'mismatch', message: '作業内容が選択した品番のものではありません。' });
  }
  if (product?.lot_required === true && (input.lotNo === null || input.lotNo === '')) {
    issues.push({ path: '/lotNo', code: 'required', message: 'この品番はロット番号の入力が必須です。' });
  }
  const workers = await rowsById(db, 'workers', input.workerIds);
  input.workerIds.forEach((id, i) => checkActive(issues, workers.get(id), `/workerIds/${i}`, '作業者'));
  const defectTypes = await rowsById(db, 'defect_types', input.defects.map((d) => d.defectTypeId), ', product_id');
  input.defects.forEach((d, i) => {
    const row = defectTypes.get(d.defectTypeId);
    if (checkActive(issues, row, `/defects/${i}/defectTypeId`, '不良種別') && row.product_id !== input.productId) {
      issues.push({ path: `/defects/${i}/defectTypeId`, code: 'mismatch', message: '不良種別が選択した品番のものではありません。' });
    }
  });
  issues.push(...validateWorkQuantities(input));
  const span = validateWorkSpan(input.workDate, new Date(input.startAt), new Date(input.endAt));
  if (!span.ok) issues.push(...span.issues);
  if (issues.length > 0 || !span.ok) throw invalid(issues);
  const holiday = await db.query('SELECT 1 FROM app.holidays WHERE holiday_date = $1 AND active', [input.workDate]);
  return computeBusinessTime({ date: input.workDate, start: span.start, end: span.end, workers: input.workerIds.length, isHoliday: (holiday.rowCount ?? 0) > 0 });
}

async function validateDelivery(db: Queryable, input: DeliveryDraftInput): Promise<void> {
  const issues: FieldIssue[] = [];
  const drivers = await rowsById(db, 'workers', [input.driverId]);
  checkActive(issues, drivers.get(input.driverId), '/driverId', '運転者');
  const customers = await rowsById(db, 'customers', [input.customerId]);
  checkActive(issues, customers.get(input.customerId), '/customerId', 'お客様');
  const products = await rowsById(db, 'products', input.items.map((it) => it.productId), ', customer_id');
  input.items.forEach((it, i) => {
    const p = products.get(it.productId);
    if (checkActive(issues, p, `/items/${i}/productId`, '品番') && p.customer_id !== input.customerId) {
      issues.push({ path: `/items/${i}/productId`, code: 'mismatch', message: '品番が選択したお客様のものではありません。' });
    }
  });
  issues.push(...validateDeliveryItems(input.items));
  if (issues.length > 0) throw invalid(issues);
}

// ------------------------------------------------------------------ revision 書込

async function writeWorkRevision(client: PoolClient, revisionId: string, input: WorkDraftInput, computed: WorkComputed, insert: { reportId: string; revisionNo: number; parentRevisionId: string | null } | null): Promise<void> {
  const values = [
    input.workDate, input.reporterId, input.customerId, input.productId, input.workTypeId, input.lotNo,
    input.startAt, input.endAt, computed.breakMinutes, computed.regularMinutes, computed.overtimeMinutes,
    computed.regularPersonMinutes, computed.overtimePersonMinutes, input.quantity,
  ];
  if (insert !== null) {
    await client.query(
      `INSERT INTO app.work_report_revisions
         (id, report_id, parent_revision_id, revision_no, work_date, reporter_id, customer_id, product_id, work_type_id, lot_no,
          start_at, end_at, break_minutes, regular_minutes, overtime_minutes, regular_person_minutes, overtime_person_minutes, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [revisionId, insert.reportId, insert.parentRevisionId, insert.revisionNo, ...values],
    );
  } else {
    await client.query('DELETE FROM app.work_report_workers WHERE revision_id = $1', [revisionId]);
    await client.query('DELETE FROM app.defect_results WHERE revision_id = $1', [revisionId]);
    await client.query(
      `UPDATE app.work_report_revisions SET work_date=$2, reporter_id=$3, customer_id=$4, product_id=$5, work_type_id=$6, lot_no=$7,
              start_at=$8, end_at=$9, break_minutes=$10, regular_minutes=$11, overtime_minutes=$12,
              regular_person_minutes=$13, overtime_person_minutes=$14, quantity=$15
        WHERE id = $1 AND confirmed_at IS NULL`,
      [revisionId, ...values],
    );
  }
  for (const workerId of input.workerIds) {
    await client.query('INSERT INTO app.work_report_workers (revision_id, worker_id) VALUES ($1, $2)', [revisionId, workerId]);
  }
  for (const d of input.defects) {
    await client.query('INSERT INTO app.defect_results (revision_id, defect_type_id, quantity) VALUES ($1, $2, $3)', [revisionId, d.defectTypeId, d.quantity]);
  }
}

async function writeDeliveryRevision(client: PoolClient, revisionId: string, input: DeliveryDraftInput, insert: { reportId: string; revisionNo: number; parentRevisionId: string | null } | null): Promise<void> {
  if (insert !== null) {
    await client.query(
      `INSERT INTO app.delivery_report_revisions (id, report_id, parent_revision_id, revision_no, delivery_date, driver_id, customer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [revisionId, insert.reportId, insert.parentRevisionId, insert.revisionNo, input.deliveryDate, input.driverId, input.customerId],
    );
  } else {
    await client.query('DELETE FROM app.delivery_items WHERE delivery_revision_id = $1', [revisionId]);
    await client.query(
      'UPDATE app.delivery_report_revisions SET delivery_date=$2, driver_id=$3, customer_id=$4 WHERE id = $1 AND confirmed_at IS NULL',
      [revisionId, input.deliveryDate, input.driverId, input.customerId],
    );
  }
  for (const it of input.items) {
    await client.query('INSERT INTO app.delivery_items (delivery_revision_id, product_id, quantity) VALUES ($1, $2, $3)', [revisionId, it.productId, it.quantity]);
  }
}

// ------------------------------------------------------------------ 読取

interface RevisionHead {
  id: string;
  revision_no: number;
  parent_revision_id: string | null;
  confirmed_at: Date | null;
}

async function latestRevision(db: Queryable, type: FieldReportType, reportId: string): Promise<RevisionHead | null> {
  const r = await db.query<RevisionHead>(
    `SELECT id, revision_no, parent_revision_id, confirmed_at FROM app.${TABLES[type].revision} WHERE report_id = $1 ORDER BY revision_no DESC LIMIT 1`,
    [reportId],
  );
  return r.rows[0] ?? null;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

async function workDetail(db: Queryable, header: HeaderRow): Promise<Record<string, unknown>> {
  const rev = (
    await db.query(
      `SELECT * FROM app.work_report_revisions WHERE report_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [header.id],
    )
  ).rows[0] as Record<string, unknown>;
  const workers = await db.query<{ worker_id: string }>(
    `SELECT w.worker_id FROM app.work_report_workers w JOIN app.workers m ON m.id = w.worker_id WHERE w.revision_id = $1 ORDER BY m.code, m.id`,
    [rev['id']],
  );
  const defects = await db.query<{ defect_type_id: string; quantity: number }>(
    `SELECT d.defect_type_id, d.quantity FROM app.defect_results d JOIN app.defect_types t ON t.id = d.defect_type_id
      WHERE d.revision_id = $1 ORDER BY t.sort_order, t.code`,
    [rev['id']],
  );
  return {
    id: header.id,
    reportNo: header.report_no,
    status: header.status,
    version: header.version,
    documentStatus: null,
    ownerId: header.owner_id,
    revisionId: rev['id'],
    revisionNo: rev['revision_no'],
    parentRevisionId: rev['parent_revision_id'] ?? null,
    confirmedAt: rev['confirmed_at'] === null ? null : toIso(rev['confirmed_at']),
    workDate: rev['work_date'],
    reporterId: rev['reporter_id'],
    customerId: rev['customer_id'],
    productId: rev['product_id'],
    workTypeId: rev['work_type_id'],
    lotNo: rev['lot_no'] ?? null,
    workerIds: workers.rows.map((w) => w.worker_id),
    startAt: toIso(rev['start_at']),
    endAt: toIso(rev['end_at']),
    quantity: rev['quantity'],
    defects: defects.rows.map((d) => ({ defectTypeId: d.defect_type_id, quantity: d.quantity })),
    breakMinutes: rev['break_minutes'],
    regularMinutes: rev['regular_minutes'],
    overtimeMinutes: rev['overtime_minutes'],
    regularPersonMinutes: rev['regular_person_minutes'],
    overtimePersonMinutes: rev['overtime_person_minutes'],
  };
}

async function deliveryDetail(db: Queryable, header: HeaderRow): Promise<Record<string, unknown>> {
  const rev = (
    await db.query(`SELECT * FROM app.delivery_report_revisions WHERE report_id = $1 ORDER BY revision_no DESC LIMIT 1`, [header.id])
  ).rows[0] as Record<string, unknown>;
  const items = await db.query<{ product_id: string; quantity: number; allocation_eligible: boolean }>(
    `SELECT i.product_id, i.quantity, i.allocation_eligible FROM app.delivery_items i JOIN app.products p ON p.id = i.product_id
      WHERE i.delivery_revision_id = $1 ORDER BY p.code, p.id`,
    [rev['id']],
  );
  return {
    id: header.id,
    reportNo: header.report_no,
    status: header.status,
    version: header.version,
    documentStatus: null,
    ownerId: header.owner_id,
    revisionId: rev['id'],
    revisionNo: rev['revision_no'],
    parentRevisionId: rev['parent_revision_id'] ?? null,
    confirmedAt: rev['confirmed_at'] === null ? null : toIso(rev['confirmed_at']),
    deliveryDate: rev['delivery_date'],
    driverId: rev['driver_id'],
    customerId: rev['customer_id'],
    items: items.rows.map((i) => ({ productId: i.product_id, quantity: i.quantity, allocationEligible: i.allocation_eligible })),
  };
}

function versionConflict(header: HeaderRow, detail: Record<string, unknown>, input: Record<string, unknown>): FieldError {
  const changedFields = Object.keys(input)
    .filter((k) => k !== 'expectedVersion' && k !== 'reason' && k in detail)
    .filter((k) => JSON.stringify(detail[k]) !== JSON.stringify(input[k]))
    .map((k) => `/${k}`);
  return new FieldError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], {
    currentVersion: header.version,
    changedFields,
  });
}

function stateConflict(header: HeaderRow, message: string): FieldError {
  return new FieldError(409, 'STATE_CONFLICT', message, [], { currentVersion: header.version, currentStatus: header.status });
}

// ------------------------------------------------------------------ service

export class FieldReportService {
  constructor(private readonly pool: Pool) {}

  async get(type: FieldReportType, id: string, actor: FieldActor): Promise<Record<string, unknown>> {
    const r = await this.pool.query<HeaderRow>(
      `SELECT id, report_no, status, owner_id, version, current_revision_id FROM app.${TABLES[type].header} WHERE id = $1`,
      [id],
    );
    const header = r.rows[0];
    if (header === undefined || (!canReadAll(actor) && header.owner_id !== actor.userId)) throw notFound(type);
    return type === 'WORK' ? workDetail(this.pool, header) : deliveryDetail(this.pool, header);
  }

  async createWork(input: WorkDraftInput, ctx: FieldContext): Promise<RecordSummary> {
    return withTransaction(this.pool, async (client) => {
      const computed = await validateWork(client, input, ctx.actor.userId);
      const reportNo = await allocateReportNo(client, 'WORK', ctx.now);
      const reportId = randomUUID();
      const revisionId = randomUUID();
      await client.query(`INSERT INTO app.work_reports (id, report_no, status, owner_id) VALUES ($1, $2, 'DRAFT', $3)`, [reportId, reportNo, ctx.actor.userId]);
      await writeWorkRevision(client, revisionId, input, computed, { reportId, revisionNo: 1, parentRevisionId: null });
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: 'WORK_REPORT_CREATE',
        targetType: TABLES.WORK.target,
        targetId: reportId,
        afterData: { reportNo, revisionId, revisionNo: 1, status: 'DRAFT', ...computed },
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { id: reportId, reportNo, status: 'DRAFT', version: 1, documentStatus: null, type: 'WORK', businessDate: input.workDate, revisionNo: 1 };
    });
  }

  async createDelivery(input: DeliveryDraftInput, ctx: FieldContext): Promise<RecordSummary> {
    return withTransaction(this.pool, async (client) => {
      await validateDelivery(client, input);
      const reportNo = await allocateReportNo(client, 'DELIVERY', ctx.now);
      const reportId = randomUUID();
      const revisionId = randomUUID();
      await client.query(`INSERT INTO app.delivery_reports (id, report_no, status, owner_id) VALUES ($1, $2, 'DRAFT', $3)`, [reportId, reportNo, ctx.actor.userId]);
      await writeDeliveryRevision(client, revisionId, input, { reportId, revisionNo: 1, parentRevisionId: null });
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: 'DELIVERY_REPORT_CREATE',
        targetType: TABLES.DELIVERY.target,
        targetId: reportId,
        afterData: { reportNo, revisionId, revisionNo: 1, status: 'DRAFT', itemCount: input.items.length },
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { id: reportId, reportNo, status: 'DRAFT', version: 1, documentStatus: null, type: 'DELIVERY', businessDate: input.deliveryDate, revisionNo: 1 };
    });
  }

  /** 共通: lock → scope → version → state(DRAFT + 未確定revision) */
  private async lockDraft(client: PoolClient, type: FieldReportType, id: string, expectedVersion: number, input: Record<string, unknown>, ctx: FieldContext): Promise<{ header: HeaderRow; revision: RevisionHead }> {
    const header = await lockHeader(client, type, id);
    if (header === null || (!canReadAll(ctx.actor) && header.owner_id !== ctx.actor.userId)) throw notFound(type);
    if (!canWrite(ctx.actor, header)) {
      throw new FieldError(403, 'FORBIDDEN', 'この操作を行う権限がありません。');
    }
    if (header.version !== expectedVersion) {
      const detail = type === 'WORK' ? await workDetail(client, header) : await deliveryDetail(client, header);
      throw versionConflict(header, detail, input);
    }
    const revision = await latestRevision(client, type, id);
    if (header.status !== 'DRAFT' || revision === null || revision.confirmed_at !== null) {
      throw stateConflict(header, '下書き以外は変更・確定できません。');
    }
    return { header, revision };
  }

  async updateWork(id: string, input: WorkDraftInput & { expectedVersion: number }, ctx: FieldContext): Promise<RecordSummary> {
    return withTransaction(this.pool, async (client) => {
      const { header, revision } = await this.lockDraft(client, 'WORK', id, input.expectedVersion, input, ctx);
      const before = await workDetail(client, header);
      const computed = await validateWork(client, input, before['reporterId'] as string);
      await writeWorkRevision(client, revision.id, input, computed, null);
      const version = await this.bumpVersion(client, 'WORK', id, null);
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: 'WORK_REPORT_UPDATE',
        targetType: TABLES.WORK.target,
        targetId: id,
        beforeData: summarizeWork(before),
        afterData: { ...summarizeWork({ ...input }), ...computed, version },
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { id, reportNo: header.report_no, status: 'DRAFT', version, documentStatus: null, type: 'WORK', businessDate: input.workDate, revisionNo: revision.revision_no };
    });
  }

  async updateDelivery(id: string, input: DeliveryDraftInput & { expectedVersion: number }, ctx: FieldContext): Promise<RecordSummary> {
    return withTransaction(this.pool, async (client) => {
      const { header, revision } = await this.lockDraft(client, 'DELIVERY', id, input.expectedVersion, input, ctx);
      const before = await deliveryDetail(client, header);
      await validateDelivery(client, input);
      await writeDeliveryRevision(client, revision.id, input, null);
      const version = await this.bumpVersion(client, 'DELIVERY', id, null);
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: 'DELIVERY_REPORT_UPDATE',
        targetType: TABLES.DELIVERY.target,
        targetId: id,
        beforeData: summarizeDelivery(before),
        afterData: { ...summarizeDelivery({ ...input }), version },
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { id, reportNo: header.report_no, status: 'DRAFT', version, documentStatus: null, type: 'DELIVERY', businessDate: input.deliveryDate, revisionNo: revision.revision_no };
    });
  }

  private async bumpVersion(client: PoolClient, type: FieldReportType, id: string, confirm: { status: 'CONFIRMED'; revisionId: string } | null): Promise<number> {
    const r = await client.query<{ version: number }>(
      confirm === null
        ? `UPDATE app.${TABLES[type].header} SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`
        : `UPDATE app.${TABLES[type].header} SET version = version + 1, updated_at = now(), status = 'CONFIRMED', current_revision_id = $2 WHERE id = $1 RETURNING version`,
      confirm === null ? [id] : [id, confirm.revisionId],
    );
    return r.rows[0]?.version as number;
  }

  /** confirm は caller（handler）が Idempotency を管理し、ここは 1 transaction で確定する */
  async confirm(type: FieldReportType, id: string, expectedVersion: number, ctx: FieldContext): Promise<RecordSummary> {
    return withTransaction(this.pool, async (client) => {
      const { header, revision } = await this.lockDraft(client, type, id, expectedVersion, { expectedVersion }, ctx);
      const detail = type === 'WORK' ? await workDetail(client, header) : await deliveryDetail(client, header);
      let businessDate: string;
      let auditExtra: Record<string, unknown>;
      if (type === 'WORK') {
        const input = detailToWorkInput(detail);
        const computed = await validateWork(client, input, input.reporterId);
        await client.query(
          `UPDATE app.work_report_revisions SET break_minutes=$2, regular_minutes=$3, overtime_minutes=$4,
                  regular_person_minutes=$5, overtime_person_minutes=$6, confirmed_at = $7 WHERE id = $1 AND confirmed_at IS NULL`,
          [revision.id, computed.breakMinutes, computed.regularMinutes, computed.overtimeMinutes, computed.regularPersonMinutes, computed.overtimePersonMinutes, ctx.now.toISOString()],
        );
        businessDate = input.workDate;
        auditExtra = { ...computed };
      } else {
        const input = detailToDeliveryInput(detail);
        await validateDelivery(client, input);
        // GAP-016: 運搬日に有効な ALLOCATED 運搬ルールがある品番を按分対象とする（CHG-002 D3）
        await client.query(
          `UPDATE app.delivery_items i SET allocation_eligible = EXISTS (
              SELECT 1 FROM app.transport_rules r
               WHERE r.product_id = i.product_id AND r.active AND r.type = 'ALLOCATED'
                 AND r.valid_from <= $2::date AND (r.valid_to IS NULL OR r.valid_to >= $2::date))
            WHERE i.delivery_revision_id = $1`,
          [revision.id, input.deliveryDate],
        );
        await client.query('UPDATE app.delivery_report_revisions SET confirmed_at = $2 WHERE id = $1 AND confirmed_at IS NULL', [revision.id, ctx.now.toISOString()]);
        businessDate = input.deliveryDate;
        const eligible = await client.query<{ n: string }>('SELECT count(*) AS n FROM app.delivery_items WHERE delivery_revision_id = $1 AND allocation_eligible', [revision.id]);
        auditExtra = { itemCount: input.items.length, allocationEligibleCount: Number(eligible.rows[0]?.n ?? 0) };
      }
      const version = await this.bumpVersion(client, type, id, { status: 'CONFIRMED', revisionId: revision.id });
      const eventType: OutboxEventType = type === 'WORK' ? 'WorkReportConfirmed' : 'DeliveryReportConfirmed';
      await new PgOutboxRepository(client).enqueue({
        eventId: randomUUID(),
        type: eventType,
        version: 1,
        occurredAt: ctx.now.toISOString(),
        aggregateType: type === 'WORK' ? 'Work' : 'Delivery',
        aggregateId: id,
        correlationId: ctx.correlationId,
        causationId: null,
        payload: { reportId: id, reportNo: header.report_no, revisionId: revision.id, revisionNo: revision.revision_no, version, actorId: ctx.actor.userId },
      });
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: type === 'WORK' ? 'WORK_REPORT_CONFIRM' : 'DELIVERY_REPORT_CONFIRM',
        targetType: TABLES[type].target,
        targetId: id,
        beforeData: { status: 'DRAFT', version: header.version },
        afterData: { status: 'CONFIRMED', version, revisionId: revision.id, revisionNo: revision.revision_no, ...auditExtra },
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { id, reportNo: header.report_no, status: 'CONFIRMED', version, documentStatus: null, type, businessDate, revisionNo: revision.revision_no };
    });
  }

  /** API-012: 業務日 DESC, id ASC。FIELD（全件参照ロール無し）は owner=本人のみ（CHG-002） */
  async list(
    actor: FieldActor,
    q: { page: number; pageSize: number; status: string | null; dateFrom: string | null; dateTo: string | null },
  ): Promise<{ data: RecordSummary[]; meta: { page: number; pageSize: number; total: number } }> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (!canReadAll(actor)) {
      params.push(actor.userId);
      where.push(`owner_id = $${params.length}`);
    }
    if (q.status !== null) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    if (q.dateFrom !== null) {
      params.push(q.dateFrom);
      where.push(`business_date >= $${params.length}::date`);
    }
    if (q.dateTo !== null) {
      params.push(q.dateTo);
      where.push(`business_date <= $${params.length}::date`);
    }
    const union = `
      SELECT h.id, h.report_no, h.status::text AS status, h.version, h.owner_id, 'WORK' AS type, r.work_date AS business_date, r.revision_no
        FROM app.work_reports h
        JOIN LATERAL (SELECT work_date, revision_no FROM app.work_report_revisions WHERE report_id = h.id ORDER BY revision_no DESC LIMIT 1) r ON true
      UNION ALL
      SELECT h.id, h.report_no, h.status::text, h.version, h.owner_id, 'DELIVERY', r.delivery_date, r.revision_no
        FROM app.delivery_reports h
        JOIN LATERAL (SELECT delivery_date, revision_no FROM app.delivery_report_revisions WHERE report_id = h.id ORDER BY revision_no DESC LIMIT 1) r ON true`;
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${union}) x ${whereSql}`, params);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await this.pool.query<{ id: string; report_no: string; status: string; version: number; type: FieldReportType; business_date: string; revision_no: number }>(
      `SELECT * FROM (${union}) x ${whereSql} ORDER BY business_date DESC, id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      data: rows.rows.map((r) => ({
        id: r.id,
        reportNo: r.report_no,
        status: r.status,
        version: r.version,
        documentStatus: null,
        type: r.type,
        businessDate: r.business_date,
        revisionNo: r.revision_no,
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total.rows[0]?.n ?? 0) },
    };
  }
}

function detailToWorkInput(d: Record<string, unknown>): WorkDraftInput {
  return {
    workDate: d['workDate'] as string,
    reporterId: d['reporterId'] as string,
    customerId: d['customerId'] as string,
    productId: d['productId'] as string,
    workTypeId: d['workTypeId'] as string,
    lotNo: (d['lotNo'] as string | null) ?? null,
    workerIds: d['workerIds'] as string[],
    startAt: d['startAt'] as string,
    endAt: d['endAt'] as string,
    quantity: d['quantity'] as number,
    defects: d['defects'] as Array<{ defectTypeId: string; quantity: number }>,
  };
}

function detailToDeliveryInput(d: Record<string, unknown>): DeliveryDraftInput {
  return {
    deliveryDate: d['deliveryDate'] as string,
    driverId: d['driverId'] as string,
    customerId: d['customerId'] as string,
    items: (d['items'] as Array<{ productId: string; quantity: number }>).map((i) => ({ productId: i.productId, quantity: i.quantity })),
  };
}

/** audit 用（PII 最小化: ID・数値のみ） */
function summarizeWork(d: Record<string, unknown>): Record<string, unknown> {
  const keys = ['workDate', 'customerId', 'productId', 'workTypeId', 'workerIds', 'startAt', 'endAt', 'quantity', 'defects', 'lotNo', 'version'];
  return Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]]));
}

function summarizeDelivery(d: Record<string, unknown>): Record<string, unknown> {
  const keys = ['deliveryDate', 'driverId', 'customerId', 'items', 'version'];
  return Object.fromEntries(
    keys
      .filter((k) => k in d)
      .map((k) => [k, k === 'items' ? (d[k] as Array<{ productId: string; quantity: number }>).map((i) => ({ productId: i.productId, quantity: i.quantity })) : d[k]]),
  );
}
