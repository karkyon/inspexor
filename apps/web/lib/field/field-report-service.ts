/**
 * G3 現場入力サービス（FR-002 運搬 / FR-003 作業 / FR-004 revision / CHG-002）。CHG-006: Firestore 版。
 *
 * command pipeline（機能別詳細設計書）: transaction（読込）→ header 読込 → owner/scope → expectedVersion → state guard
 *   → domain invariant（master 有効性・関係・時間・数量） → （書込）revision/header/audit/outbox → version+1 → commit。
 *   Firestore の transaction は「読込がすべて書込より前」のため、検証と読込を終えてから書込をまとめて行う。
 *
 *  - 作成（API-004/008）: header（DRAFT）＋未確定 revision（confirmedAt null）。報告番号は作成日JSTの月で採番（counters）
 *  - 更新（API-006/010）: DRAFT の未確定 revision を置換
 *  - 確定（API-007/011）: master/関係/時間/数量を再検証 → revision.confirmedAt（以後は書き換えない）
 *                         → currentRevisionId・current（月次用の要約）→ CONFIRMED → outbox
 *  - 参照（API-005/009）: owner か OFFICE/ADMIN/AUDITOR のみ。それ以外は存在を秘匿して 404
 *  - 報告者は本人のみ（SPEC-CONFLICT-G3-01: 代理入力は別CHG）
 *  - CHG-004: 作業場所・使用車・備考（作業）、使用車両・運搬回数（運搬 revision）、運搬費（運搬 header、空欄可）
 *  - CHG-006 F1: 運搬明細の allocationEligible（按分対象）は請求（Blind）用のため常に false
 */
import { randomUUID } from 'node:crypto';
import {
  computeBusinessTime,
  formatReportNo,
  resolveRecordTransition,
  type RecordRole,
  reportMonthOf,
  validateDeliveryItems,
  validateWorkQuantities,
  validateWorkSpan,
  type FieldIssue,
  type ReportKind,
} from '@inspexor/domain';
import type { OutboxEventType } from '@inspexor/application';
import {
  appendAudit,
  C,
  enqueueOutbox,
  readCounter,
  reportPath,
  REPORT_COLLECTION,
  revisionPath,
  writeCounter,
  type DeliveryCurrent,
  type DeliveryRevisionDoc,
  type DocReader,
  type DocStore,
  type DocTransaction,
  type Filter,
  type RecordDecision,
  type ReportHeaderDoc,
  type WorkCurrent,
  type WorkRevisionDoc,
} from '@inspexor/docstore';
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

/** CHG-004 D6: 報告一覧（事務所）の表示・絞込用の要約（提案書 P.6「日付・種別・客先・品番で絞り込み」） */
export interface RecordListItem extends RecordSummary {
  readonly customerId: string;
  readonly productIds: string[];
  readonly quantity: number;
  readonly tripCount: number | null;
  readonly deliveryFeeYen: number | null;
  /** CHG-007: 直近の承認・差戻し・取消（無ければ null） */
  readonly decision: DecisionOut | null;
}

/** CHG-007: 承認系の判断（API 応答） */
export interface DecisionOut {
  readonly action: RecordDecision['action'];
  readonly reason: string | null;
  readonly at: string;
  readonly actorId: string;
  readonly revisionNo: number;
}

export type DecisionAction = RecordDecision['action'];

function decisionOut(h: { decision?: RecordDecision | null | undefined }): DecisionOut | null {
  const d = h.decision ?? null;
  return d === null ? null : { action: d.action, reason: d.reason, at: d.at.toISOString(), actorId: d.actorId, revisionNo: d.revisionNo };
}

export interface RecordListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly type?: FieldReportType | null;
  readonly customerId?: string | null;
  readonly productId?: string | null;
}

/** 確定後修正（D3）を始められる状態。承認（Blind）を使わないため CONFIRMED/SUBMITTED も対象 */
export const REVISABLE_STATUSES = ['CONFIRMED', 'SUBMITTED', 'REJECTED', 'REVOKED'] as const;
/** CHG-007: 所有者（現場）が自分で修正を始められる状態（システム基本設計書 §状態遷移 REJECTED/REVOKED→revise owner） */
export const OWNER_REVISABLE_STATUSES = ['REJECTED', 'REVOKED'] as const;

function canReviseAny(actor: FieldActor): boolean {
  return actor.roles.includes('OFFICE') || actor.roles.includes('ADMIN');
}

const DECISION_COMMAND: Record<DecisionAction, 'approve' | 'reject' | 'revoke'> = { approve: 'approve', reject: 'reject', revoke: 'revoke' };
const DECISION_AUDIT: Record<DecisionAction, string> = { approve: 'APPROVE', reject: 'REJECT', revoke: 'REVOKE' };

/** 期間指定なしの一覧で、アプリ側の絞込が必要なときに読む最大件数（種別ごと）。期間指定ありは期間内を全件読む */
export const LIST_SCAN_LIMIT = 500;

const KIND: Record<FieldReportType, ReportKind> = { WORK: 'WR', DELIVERY: 'DR' };
const LABEL = {
  WORK: { label: '作業日報', target: 'WORK_REPORT' },
  DELIVERY: { label: '運搬実績', target: 'DELIVERY_REPORT' },
} as const;
const READ_ALL_ROLES = ['OFFICE', 'ADMIN', 'AUDITOR'];

type Header = ReportHeaderDoc & { readonly id: string };

function notFound(type: FieldReportType): FieldError {
  // GAP-014: 404 に対応する error code が辞書に無いため VALIDATION_ERROR + /id（G2 と同じ扱い）
  return new FieldError(404, 'VALIDATION_ERROR', `${LABEL[type].label}が見つかりません。`, [
    { path: '/id', code: 'not_found', message: `${LABEL[type].label}が見つかりません。` },
  ]);
}

function invalid(issues: readonly FieldIssue[]): FieldError {
  return new FieldError(422, 'VALIDATION_ERROR', '入力内容を確認してください。', issues);
}

function canReadAll(actor: FieldActor): boolean {
  return actor.roles.some((r) => READ_ALL_ROLES.includes(r));
}

/** OFFICE（owner/OFFICE型の対象ロール）以外は所有者のみ更新可 */
function canWrite(actor: FieldActor, header: Header): boolean {
  return actor.roles.includes('OFFICE') || header.ownerId === actor.userId;
}

async function readHeader(db: DocReader, type: FieldReportType, id: string): Promise<Header | null> {
  const h = await db.get<ReportHeaderDoc>(reportPath(type, id));
  return h === null ? null : { ...h, id };
}

// ------------------------------------------------------------------ master 検証

interface WorkComputed {
  readonly breakMinutes: number;
  readonly regularMinutes: number;
  readonly overtimeMinutes: number;
  readonly regularPersonMinutes: number;
  readonly overtimePersonMinutes: number;
}

interface MasterDoc {
  active: boolean;
  code?: string;
  customerId?: string;
  productId?: string;
  lotRequired?: boolean;
  sortOrder?: number;
}

async function docsById(db: DocReader, collection: string, ids: readonly string[]): Promise<Map<string, MasterDoc>> {
  const unique = [...new Set(ids)];
  const docs = await db.getMany<MasterDoc>(unique.map((id) => `${collection}/${id}`));
  const out = new Map<string, MasterDoc>();
  unique.forEach((id, i) => {
    const d = docs[i];
    if (d !== null && d !== undefined) out.set(id, d);
  });
  return out;
}

function checkActive(issues: FieldIssue[], row: MasterDoc | undefined, path: string, label: string): row is MasterDoc {
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

const byCodeThenId =
  (rows: Map<string, MasterDoc>) =>
  (a: string, b: string): number => {
    const ca = rows.get(a)?.code ?? '';
    const cb = rows.get(b)?.code ?? '';
    return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };

interface WorkValidated {
  readonly computed: WorkComputed;
  readonly workerIds: string[];
  readonly defects: Array<{ defectTypeId: string; quantity: number }>;
}

/** expectedReporterId: 作成時=本人、更新・確定時=下書きの報告者（OFFICE が他人の下書きを直しても報告者は変えない） */
async function validateWork(db: DocReader, input: WorkDraftInput, expectedReporterId: string): Promise<WorkValidated> {
  const issues: FieldIssue[] = [];
  if (input.reporterId !== expectedReporterId) {
    issues.push({ path: '/reporterId', code: 'proxy_unsupported', message: '報告者はログイン中の本人を指定してください（代理入力は未対応です）。' });
  }
  const customers = await docsById(db, C.customers, [input.customerId]);
  checkActive(issues, customers.get(input.customerId), '/customerId', 'お客様');
  const product = (await docsById(db, C.products, [input.productId])).get(input.productId);
  if (checkActive(issues, product, '/productId', '品番') && product.customerId !== input.customerId) {
    issues.push({ path: '/productId', code: 'mismatch', message: '品番が選択したお客様のものではありません。' });
  }
  const workType = (await docsById(db, C.workTypes, [input.workTypeId])).get(input.workTypeId);
  if (checkActive(issues, workType, '/workTypeId', '作業内容') && workType.productId !== input.productId) {
    issues.push({ path: '/workTypeId', code: 'mismatch', message: '作業内容が選択した品番のものではありません。' });
  }
  if (product?.lotRequired === true && (input.lotNo === null || input.lotNo === '')) {
    issues.push({ path: '/lotNo', code: 'required', message: 'この品番はロット番号の入力が必須です。' });
  }
  const workers = await docsById(db, C.workers, input.workerIds);
  input.workerIds.forEach((id, i) => checkActive(issues, workers.get(id), `/workerIds/${i}`, '作業者'));
  const defectTypes = await docsById(db, C.defectTypes, input.defects.map((d) => d.defectTypeId));
  input.defects.forEach((d, i) => {
    const row = defectTypes.get(d.defectTypeId);
    if (checkActive(issues, row, `/defects/${i}/defectTypeId`, '不良種別') && row.productId !== input.productId) {
      issues.push({ path: `/defects/${i}/defectTypeId`, code: 'mismatch', message: '不良種別が選択した品番のものではありません。' });
    }
  });
  // 任意項目は Zod で null に正規化済み。内部呼出（worker 試験等）で省略された場合も null と同じ扱い
  if (input.workLocationId != null) {
    checkActive(issues, (await docsById(db, C.workLocations, [input.workLocationId])).get(input.workLocationId), '/workLocationId', '作業場所');
  }
  if (input.vehicleId != null) {
    checkActive(issues, (await docsById(db, C.vehicles, [input.vehicleId])).get(input.vehicleId), '/vehicleId', '使用車');
  }
  issues.push(...validateWorkQuantities(input));
  const span = validateWorkSpan(input.workDate, new Date(input.startAt), new Date(input.endAt));
  if (!span.ok) issues.push(...span.issues);
  if (issues.length > 0 || !span.ok) throw invalid(issues);
  const holiday = (await db.query<{ active: boolean }>(C.holidays, { where: [{ field: 'holidayDate', op: '==', value: input.workDate }] })).some((h) => h.data.active);
  const computed = computeBusinessTime({ date: input.workDate, start: span.start, end: span.end, workers: input.workerIds.length, isHoliday: holiday });
  const defectOrder = (a: { defectTypeId: string }, b: { defectTypeId: string }): number => {
    const x = defectTypes.get(a.defectTypeId);
    const y = defectTypes.get(b.defectTypeId);
    const so = (x?.sortOrder ?? 0) - (y?.sortOrder ?? 0);
    if (so !== 0) return so;
    const cx = x?.code ?? '';
    const cy = y?.code ?? '';
    return cx < cy ? -1 : cx > cy ? 1 : 0;
  };
  return {
    computed,
    workerIds: [...input.workerIds].sort(byCodeThenId(workers)),
    defects: input.defects.map((d) => ({ defectTypeId: d.defectTypeId, quantity: d.quantity })).sort(defectOrder),
  };
}

async function validateDelivery(db: DocReader, input: DeliveryDraftInput): Promise<{ items: Array<{ productId: string; quantity: number; allocationEligible: boolean }> }> {
  const issues: FieldIssue[] = [];
  checkActive(issues, (await docsById(db, C.workers, [input.driverId])).get(input.driverId), '/driverId', '運転者');
  checkActive(issues, (await docsById(db, C.customers, [input.customerId])).get(input.customerId), '/customerId', 'お客様');
  const products = await docsById(db, C.products, input.items.map((it) => it.productId));
  input.items.forEach((it, i) => {
    const p = products.get(it.productId);
    if (checkActive(issues, p, `/items/${i}/productId`, '品番') && p.customerId !== input.customerId) {
      issues.push({ path: `/items/${i}/productId`, code: 'mismatch', message: '品番が選択したお客様のものではありません。' });
    }
  });
  if (input.vehicleId != null) {
    checkActive(issues, (await docsById(db, C.vehicles, [input.vehicleId])).get(input.vehicleId), '/vehicleId', '使用車両');
  }
  issues.push(...validateDeliveryItems(input.items));
  if (issues.length > 0) throw invalid(issues);
  const order = byCodeThenId(products);
  return {
    items: input.items
      .map((it) => ({ productId: it.productId, quantity: it.quantity, allocationEligible: false }))
      .sort((a, b) => order(a.productId, b.productId)),
  };
}

// ------------------------------------------------------------------ 文書の組立

function workRevisionDoc(input: WorkDraftInput, v: WorkValidated, meta: { revisionNo: number; parentRevisionId: string | null }): WorkRevisionDoc {
  return {
    revisionNo: meta.revisionNo,
    parentRevisionId: meta.parentRevisionId,
    confirmedAt: null,
    workDate: input.workDate,
    reporterId: input.reporterId,
    customerId: input.customerId,
    productId: input.productId,
    workTypeId: input.workTypeId,
    lotNo: input.lotNo ?? null,
    workerIds: v.workerIds,
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    ...v.computed,
    quantity: input.quantity,
    defects: v.defects,
    workLocationId: input.workLocationId ?? null,
    vehicleId: input.vehicleId ?? null,
    remarks: input.remarks ?? null,
  };
}

function deliveryRevisionDoc(input: DeliveryDraftInput, items: DeliveryRevisionDoc['items'], meta: { revisionNo: number; parentRevisionId: string | null }): DeliveryRevisionDoc {
  return {
    revisionNo: meta.revisionNo,
    parentRevisionId: meta.parentRevisionId,
    confirmedAt: null,
    deliveryDate: input.deliveryDate,
    driverId: input.driverId,
    customerId: input.customerId,
    vehicleId: input.vehicleId ?? null,
    tripCount: input.tripCount ?? 1,
    items,
  };
}

/** ヘッダの一覧・参照数用の要約（最新の版） */
function workSummary(r: WorkRevisionDoc): Partial<ReportHeaderDoc> {
  return {
    businessDate: r.workDate,
    customerId: r.customerId,
    productIds: [r.productId],
    quantity: r.quantity,
    tripCount: null,
    workerIds: r.workerIds,
    vehicleId: r.vehicleId,
    workLocationId: r.workLocationId,
    defectTypeIds: r.defects.map((d) => d.defectTypeId),
  };
}

function deliverySummary(r: DeliveryRevisionDoc): Partial<ReportHeaderDoc> {
  return {
    businessDate: r.deliveryDate,
    customerId: r.customerId,
    productIds: r.items.map((i) => i.productId),
    quantity: r.items.reduce((s, i) => s + i.quantity, 0),
    tripCount: r.tripCount,
    workerIds: [r.driverId],
    vehicleId: r.vehicleId,
    workLocationId: null,
    defectTypeIds: [],
  };
}

function workCurrent(revisionId: string, r: WorkRevisionDoc): WorkCurrent {
  return {
    revisionId,
    revisionNo: r.revisionNo,
    businessDate: r.workDate,
    customerId: r.customerId,
    productId: r.productId,
    workTypeId: r.workTypeId,
    quantity: r.quantity,
    defectQuantity: r.defects.reduce((s, d) => s + d.quantity, 0),
    actualMinutes: r.regularMinutes + r.overtimeMinutes,
    personMinutes: r.regularPersonMinutes + r.overtimePersonMinutes,
  };
}

function deliveryCurrent(revisionId: string, r: DeliveryRevisionDoc): DeliveryCurrent {
  return {
    revisionId,
    revisionNo: r.revisionNo,
    businessDate: r.deliveryDate,
    customerId: r.customerId,
    tripCount: r.tripCount,
    items: r.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
  };
}

// ------------------------------------------------------------------ 読取

function workDetail(header: Header, revisionId: string, rev: WorkRevisionDoc): Record<string, unknown> {
  return {
    id: header.id,
    reportNo: header.reportNo,
    status: header.status,
    version: header.version,
    documentStatus: header.documentStatus,
    documentId: header.documentId,
    ownerId: header.ownerId,
    revisionId,
    revisionNo: rev.revisionNo,
    parentRevisionId: rev.parentRevisionId,
    confirmedAt: rev.confirmedAt === null ? null : rev.confirmedAt.toISOString(),
    workDate: rev.workDate,
    reporterId: rev.reporterId,
    customerId: rev.customerId,
    productId: rev.productId,
    workTypeId: rev.workTypeId,
    lotNo: rev.lotNo,
    workerIds: [...rev.workerIds],
    startAt: rev.startAt.toISOString(),
    endAt: rev.endAt.toISOString(),
    quantity: rev.quantity,
    defects: rev.defects.map((d) => ({ defectTypeId: d.defectTypeId, quantity: d.quantity })),
    breakMinutes: rev.breakMinutes,
    regularMinutes: rev.regularMinutes,
    overtimeMinutes: rev.overtimeMinutes,
    regularPersonMinutes: rev.regularPersonMinutes,
    overtimePersonMinutes: rev.overtimePersonMinutes,
    workLocationId: rev.workLocationId,
    vehicleId: rev.vehicleId,
    remarks: rev.remarks,
    decision: decisionOut(header),
  };
}

function deliveryDetail(header: Header, revisionId: string, rev: DeliveryRevisionDoc): Record<string, unknown> {
  return {
    id: header.id,
    reportNo: header.reportNo,
    status: header.status,
    version: header.version,
    documentStatus: header.documentStatus,
    documentId: header.documentId,
    ownerId: header.ownerId,
    revisionId,
    revisionNo: rev.revisionNo,
    parentRevisionId: rev.parentRevisionId,
    confirmedAt: rev.confirmedAt === null ? null : rev.confirmedAt.toISOString(),
    deliveryDate: rev.deliveryDate,
    driverId: rev.driverId,
    customerId: rev.customerId,
    items: rev.items.map((i) => ({ productId: i.productId, quantity: i.quantity, allocationEligible: i.allocationEligible })),
    vehicleId: rev.vehicleId,
    tripCount: rev.tripCount,
    deliveryFeeYen: header.deliveryFeeYen,
    decision: decisionOut(header),
  };
}

async function readLatest<R>(db: DocReader, type: FieldReportType, header: Header): Promise<R> {
  const rev = await db.get<R>(revisionPath(type, header.id, header.latestRevisionId));
  if (rev === null) throw new Error(`revision missing: ${header.id}/${header.latestRevisionId}`);
  return rev;
}

async function detailOf(db: DocReader, type: FieldReportType, header: Header): Promise<Record<string, unknown>> {
  return type === 'WORK'
    ? workDetail(header, header.latestRevisionId, await readLatest<WorkRevisionDoc>(db, type, header))
    : deliveryDetail(header, header.latestRevisionId, await readLatest<DeliveryRevisionDoc>(db, type, header));
}

function versionConflict(header: Header, detail: Record<string, unknown>, input: Record<string, unknown>): FieldError {
  const changedFields = Object.keys(input)
    .filter((k) => k !== 'expectedVersion' && k !== 'reason' && k in detail)
    .filter((k) => JSON.stringify(detail[k]) !== JSON.stringify(input[k]))
    .map((k) => `/${k}`);
  return new FieldError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], {
    currentVersion: header.version,
    changedFields,
  });
}

function stateConflict(header: Header, message: string): FieldError {
  return new FieldError(409, 'STATE_CONFLICT', message, [], { currentVersion: header.version, currentStatus: header.status });
}

function summaryOf(type: FieldReportType, header: Header | ReportHeaderDoc & { id: string }): RecordSummary {
  return {
    id: header.id,
    reportNo: header.reportNo,
    status: header.status,
    version: header.version,
    documentStatus: header.documentStatus,
    type,
    businessDate: header.businessDate,
    revisionNo: header.latestRevisionNo,
  };
}

// ------------------------------------------------------------------ service

export class FieldReportService {
  constructor(private readonly store: DocStore) {}

  async get(type: FieldReportType, id: string, actor: FieldActor): Promise<Record<string, unknown>> {
    const header = await readHeader(this.store, type, id);
    if (header === null || (!canReadAll(actor) && header.ownerId !== actor.userId)) throw notFound(type);
    return detailOf(this.store, type, header);
  }

  /** 報告番号の採番（読込段階） */
  private async nextNo(tx: DocTransaction, type: FieldReportType, now: Date): Promise<{ reportNo: string; counter: string; seq: number }> {
    const kind = KIND[type];
    const month = reportMonthOf(now);
    const counter = `${kind}-${month}`;
    const seq = (await readCounter(tx, counter)) + 1;
    return { reportNo: formatReportNo(kind, month, seq), counter, seq };
  }

  private newHeader(type: FieldReportType, reportNo: string, ownerId: string, revisionId: string, summary: Partial<ReportHeaderDoc>, deliveryFeeYen: number | null, now: Date): ReportHeaderDoc {
    return {
      reportNo,
      status: 'DRAFT',
      ownerId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      latestRevisionId: revisionId,
      latestRevisionNo: 1,
      currentRevisionId: null,
      businessDate: '',
      customerId: '',
      productIds: [],
      quantity: 0,
      tripCount: null,
      workerIds: [],
      vehicleId: null,
      workLocationId: null,
      defectTypeIds: [],
      ...summary,
      deliveryFeeYen: type === 'DELIVERY' ? deliveryFeeYen : null,
      documentId: null,
      documentStatus: null,
      current: null,
    };
  }

  async createWork(input: WorkDraftInput, ctx: FieldContext): Promise<RecordSummary> {
    const reportId = randomUUID();
    const revisionId = randomUUID();
    return this.store.runTransaction(async (tx) => {
      const v = await validateWork(tx, input, ctx.actor.userId);
      const no = await this.nextNo(tx, 'WORK', ctx.now);
      const rev = workRevisionDoc(input, v, { revisionNo: 1, parentRevisionId: null });
      const header = this.newHeader('WORK', no.reportNo, ctx.actor.userId, revisionId, workSummary(rev), null, ctx.now);
      writeCounter(tx, no.counter, no.seq);
      tx.create(reportPath('WORK', reportId), header);
      tx.create(revisionPath('WORK', reportId, revisionId), rev);
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: 'WORK_REPORT_CREATE',
          targetType: LABEL.WORK.target,
          targetId: reportId,
          afterData: { reportNo: no.reportNo, revisionId, revisionNo: 1, status: 'DRAFT', ...v.computed },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return summaryOf('WORK', { ...header, id: reportId });
    });
  }

  async createDelivery(input: DeliveryDraftInput, ctx: FieldContext): Promise<RecordSummary> {
    const reportId = randomUUID();
    const revisionId = randomUUID();
    return this.store.runTransaction(async (tx) => {
      const v = await validateDelivery(tx, input);
      const no = await this.nextNo(tx, 'DELIVERY', ctx.now);
      const rev = deliveryRevisionDoc(input, v.items, { revisionNo: 1, parentRevisionId: null });
      const header = this.newHeader('DELIVERY', no.reportNo, ctx.actor.userId, revisionId, deliverySummary(rev), input.deliveryFeeYen ?? null, ctx.now);
      writeCounter(tx, no.counter, no.seq);
      tx.create(reportPath('DELIVERY', reportId), header);
      tx.create(revisionPath('DELIVERY', reportId, revisionId), rev);
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: 'DELIVERY_REPORT_CREATE',
          targetType: LABEL.DELIVERY.target,
          targetId: reportId,
          afterData: { reportNo: no.reportNo, revisionId, revisionNo: 1, status: 'DRAFT', itemCount: input.items.length },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return summaryOf('DELIVERY', { ...header, id: reportId });
    });
  }

  /** 共通: header 読込 → scope → version → state(DRAFT + 未確定revision) */
  private async readDraft<R extends { confirmedAt: Date | null }>(
    tx: DocTransaction,
    type: FieldReportType,
    id: string,
    expectedVersion: number,
    input: Record<string, unknown>,
    ctx: FieldContext,
  ): Promise<{ header: Header; revision: R }> {
    const header = await readHeader(tx, type, id);
    if (header === null || (!canReadAll(ctx.actor) && header.ownerId !== ctx.actor.userId)) throw notFound(type);
    if (!canWrite(ctx.actor, header)) {
      throw new FieldError(403, 'FORBIDDEN', 'この操作を行う権限がありません。');
    }
    const revision = await readLatest<R>(tx, type, header);
    if (header.version !== expectedVersion) {
      const detail =
        type === 'WORK'
          ? workDetail(header, header.latestRevisionId, revision as unknown as WorkRevisionDoc)
          : deliveryDetail(header, header.latestRevisionId, revision as unknown as DeliveryRevisionDoc);
      throw versionConflict(header, detail, input);
    }
    if (header.status !== 'DRAFT' || revision.confirmedAt !== null) {
      throw stateConflict(header, '下書き以外は変更・確定できません。');
    }
    return { header, revision };
  }

  async updateWork(id: string, input: WorkDraftInput & { expectedVersion: number }, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      const { header, revision } = await this.readDraft<WorkRevisionDoc>(tx, 'WORK', id, input.expectedVersion, input, ctx);
      const before = workDetail(header, header.latestRevisionId, revision);
      const v = await validateWork(tx, input, revision.reporterId);
      const rev = workRevisionDoc(input, v, { revisionNo: revision.revisionNo, parentRevisionId: revision.parentRevisionId });
      const version = header.version + 1;
      tx.set(revisionPath('WORK', id, header.latestRevisionId), rev);
      tx.update(reportPath('WORK', id), { ...workSummary(rev), version, updatedAt: ctx.now });
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: 'WORK_REPORT_UPDATE',
          targetType: LABEL.WORK.target,
          targetId: id,
          beforeData: summarizeWork(before),
          afterData: { ...summarizeWork({ ...input }), ...v.computed, version },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: 'DRAFT', version, documentStatus: null, type: 'WORK', businessDate: input.workDate, revisionNo: revision.revisionNo };
    });
  }

  async updateDelivery(id: string, input: DeliveryDraftInput & { expectedVersion: number }, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      const { header, revision } = await this.readDraft<DeliveryRevisionDoc>(tx, 'DELIVERY', id, input.expectedVersion, input, ctx);
      const before = deliveryDetail(header, header.latestRevisionId, revision);
      const v = await validateDelivery(tx, input);
      const rev = deliveryRevisionDoc(input, v.items, { revisionNo: revision.revisionNo, parentRevisionId: revision.parentRevisionId });
      const version = header.version + 1;
      tx.set(revisionPath('DELIVERY', id, header.latestRevisionId), rev);
      // 運搬費は header（D2: 運搬報告1件に1金額）
      tx.update(reportPath('DELIVERY', id), { ...deliverySummary(rev), deliveryFeeYen: input.deliveryFeeYen ?? null, version, updatedAt: ctx.now });
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: 'DELIVERY_REPORT_UPDATE',
          targetType: LABEL.DELIVERY.target,
          targetId: id,
          beforeData: summarizeDelivery(before),
          afterData: { ...summarizeDelivery({ ...input }), version },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: 'DRAFT', version, documentStatus: null, type: 'DELIVERY', businessDate: input.deliveryDate, revisionNo: revision.revisionNo };
    });
  }

  /** confirm は caller（handler）が Idempotency を管理し、ここは 1 transaction で確定する */
  async confirm(type: FieldReportType, id: string, expectedVersion: number, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      let businessDate: string;
      let auditExtra: Record<string, unknown>;
      let header: Header;
      let revisionNo: number;
      const write: Array<() => void> = [];
      const version = expectedVersion + 1;
      if (type === 'WORK') {
        const d = await this.readDraft<WorkRevisionDoc>(tx, 'WORK', id, expectedVersion, { expectedVersion }, ctx);
        header = d.header;
        const input = revisionToWorkInput(d.revision);
        const v = await validateWork(tx, input, d.revision.reporterId);
        const rev: WorkRevisionDoc = { ...workRevisionDoc(input, v, { revisionNo: d.revision.revisionNo, parentRevisionId: d.revision.parentRevisionId }), confirmedAt: ctx.now };
        write.push(() => {
          tx.set(revisionPath('WORK', id, header.latestRevisionId), rev);
          tx.update(reportPath('WORK', id), {
            ...workSummary(rev),
            status: 'CONFIRMED',
            currentRevisionId: header.latestRevisionId,
            current: workCurrent(header.latestRevisionId, rev),
            version,
            updatedAt: ctx.now,
          });
        });
        businessDate = input.workDate;
        revisionNo = rev.revisionNo;
        auditExtra = { ...v.computed };
      } else {
        const d = await this.readDraft<DeliveryRevisionDoc>(tx, 'DELIVERY', id, expectedVersion, { expectedVersion }, ctx);
        header = d.header;
        const input = revisionToDeliveryInput(d.revision, header.deliveryFeeYen);
        const v = await validateDelivery(tx, input);
        const rev: DeliveryRevisionDoc = { ...deliveryRevisionDoc(input, v.items, { revisionNo: d.revision.revisionNo, parentRevisionId: d.revision.parentRevisionId }), confirmedAt: ctx.now };
        write.push(() => {
          tx.set(revisionPath('DELIVERY', id, header.latestRevisionId), rev);
          tx.update(reportPath('DELIVERY', id), {
            ...deliverySummary(rev),
            status: 'CONFIRMED',
            currentRevisionId: header.latestRevisionId,
            current: deliveryCurrent(header.latestRevisionId, rev),
            version,
            updatedAt: ctx.now,
          });
        });
        businessDate = input.deliveryDate;
        revisionNo = rev.revisionNo;
        // CHG-006 F1: 按分対象の判定（運搬ルール）は Blind のため 0
        auditExtra = { itemCount: input.items.length, allocationEligibleCount: 0 };
      }
      // ---- 書込
      for (const w of write) w();
      const eventType: OutboxEventType = type === 'WORK' ? 'WorkReportConfirmed' : 'DeliveryReportConfirmed';
      enqueueOutbox(
        tx,
        {
          eventId: randomUUID(),
          type: eventType,
          version: 1,
          occurredAt: ctx.now.toISOString(),
          aggregateType: type === 'WORK' ? 'Work' : 'Delivery',
          aggregateId: id,
          correlationId: ctx.correlationId,
          causationId: null,
          payload: { reportId: id, reportNo: header.reportNo, revisionId: header.latestRevisionId, revisionNo, version, actorId: ctx.actor.userId },
        },
        ctx.now,
      );
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: type === 'WORK' ? 'WORK_REPORT_CONFIRM' : 'DELIVERY_REPORT_CONFIRM',
          targetType: LABEL[type].target,
          targetId: id,
          beforeData: { status: 'DRAFT', version: header.version },
          afterData: { status: 'CONFIRMED', version, revisionId: header.latestRevisionId, revisionNo, ...auditExtra },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: 'CONFIRMED', version, documentStatus: null, type, businessDate, revisionNo };
    });
  }

  /**
   * API-012: 業務日 DESC, 作成日時 DESC, id ASC（CHG-004 D5: 同じ日は新しい登録が先）。FIELD（全件参照ロール無し）は owner=本人のみ（CHG-002）。
   * CHG-004 D6: 種別・お客様・品番の絞込と、一覧表示用の要約（お客様・品番・数量・運搬回数・運搬費）。
   *
   * CHG-006: 種別ごとのコレクションを検索して合わせる。絞込のうち1つ（本人 > 品番 > お客様 > 状態）を Firestore の検索に含め、
   *   それだけで済む場合は「並び順＋件数制限＋count」で必要な件数だけ読む。2つ以上の絞込がある場合は、期間内を全件
   *   （期間指定なしは種別ごとに新しい順で最大 LIST_SCAN_LIMIT 件）読んで残りをアプリで絞り込む。
   */
  async list(actor: FieldActor, q: RecordListQuery): Promise<{ data: RecordListItem[]; meta: { page: number; pageSize: number; total: number } }> {
    const types: FieldReportType[] = q.type === 'WORK' || q.type === 'DELIVERY' ? [q.type] : ['WORK', 'DELIVERY'];
    const equality: Filter[] = [];
    if (!canReadAll(actor)) equality.push({ field: 'ownerId', op: '==', value: actor.userId });
    if (q.productId) equality.push({ field: 'productIds', op: 'array-contains', value: q.productId });
    if (q.customerId) equality.push({ field: 'customerId', op: '==', value: q.customerId });
    if (q.status) equality.push({ field: 'status', op: '==', value: q.status });
    const pushed = equality.slice(0, 1);
    const rest = equality.slice(1);
    const range: Filter[] = [];
    if (q.dateFrom) range.push({ field: 'businessDate', op: '>=', value: q.dateFrom });
    if (q.dateTo) range.push({ field: 'businessDate', op: '<=', value: q.dateTo });
    const orderBy = [
      { field: 'businessDate', dir: 'desc' as const },
      { field: 'createdAt', dir: 'desc' as const },
    ];
    const where = [...pushed, ...range];
    const matchesRest = (h: ReportHeaderDoc): boolean =>
      rest.every((f) => (f.op === 'array-contains' ? (h[f.field as keyof ReportHeaderDoc] as readonly string[]).includes(f.value as string) : h[f.field as keyof ReportHeaderDoc] === f.value));

    const rows: Array<{ type: FieldReportType; id: string; h: ReportHeaderDoc }> = [];
    let total = 0;
    const need = q.page * q.pageSize;
    for (const type of types) {
      if (rest.length === 0) {
        const found = await this.store.query<ReportHeaderDoc>(REPORT_COLLECTION[type], { where, orderBy, limit: need });
        rows.push(...found.map((r) => ({ type, id: r.id, h: r.data })));
        total += await this.store.count(REPORT_COLLECTION[type], { where, orderBy });
      } else {
        const limit = range.length === 0 ? LIST_SCAN_LIMIT : undefined;
        const found = await this.store.query<ReportHeaderDoc>(REPORT_COLLECTION[type], { where, orderBy, ...(limit !== undefined ? { limit } : {}) });
        const hit = found.filter((r) => matchesRest(r.data));
        rows.push(...hit.map((r) => ({ type, id: r.id, h: r.data })));
        total += hit.length;
      }
    }
    rows.sort((a, b) => {
      if (a.h.businessDate !== b.h.businessDate) return a.h.businessDate < b.h.businessDate ? 1 : -1;
      const ca = a.h.createdAt.getTime();
      const cb = b.h.createdAt.getTime();
      if (ca !== cb) return cb - ca;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const start = (q.page - 1) * q.pageSize;
    return {
      data: rows.slice(start, start + q.pageSize).map(({ type, id, h }) => ({
        id,
        reportNo: h.reportNo,
        status: h.status,
        version: h.version,
        documentStatus: h.documentStatus,
        type,
        businessDate: h.businessDate,
        revisionNo: h.latestRevisionNo,
        customerId: h.customerId,
        productIds: [...h.productIds],
        quantity: h.quantity,
        tripCount: type === 'DELIVERY' ? h.tripCount : null,
        deliveryFeeYen: type === 'DELIVERY' ? h.deliveryFeeYen : null,
        decision: decisionOut(h),
      })),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  /**
   * API-013 transitionRecord `revise`（CHG-004 D3: 確定後の事務所修正）。
   * 確定版は残し、親 revision 付きの新しい下書き revision（内容は複製）を作る。以後は PATCH（API-006/010）で直し、
   * confirm（API-007/011）で新しい版として確定 → 帳票も新しい版で作成される。理由必須・監査。
   * 月次集計は新しい版が確定するまで前の確定版（current）で数える。
   */
  async revise(type: FieldReportType, id: string, cmd: { expectedVersion: number; reason: string }, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      const header = await readHeader(tx, type, id);
      if (header === null) throw notFound(type);
      if (header.version !== cmd.expectedVersion) {
        throw new FieldError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: header.version, changedFields: ['/status'] });
      }
      if (!canReviseAny(ctx.actor)) {
        // CHG-007: 事務所以外は、差戻し・取消された自分の報告だけ修正できる（owner revise）
        if (header.ownerId !== ctx.actor.userId) throw notFound(type);
        if (!(OWNER_REVISABLE_STATUSES as readonly string[]).includes(header.status)) {
          throw new FieldError(403, 'FORBIDDEN', '差戻し・取消された報告だけを修正できます。');
        }
      }
      const latest = await readLatest<WorkRevisionDoc | DeliveryRevisionDoc>(tx, type, header);
      if (!(REVISABLE_STATUSES as readonly string[]).includes(header.status) || latest.confirmedAt === null) {
        throw stateConflict(header, '確定済みの報告だけを修正できます（下書き中の修正は、そのまま編集して確定してください）。');
      }
      const revisionId = randomUUID();
      const revisionNo = latest.revisionNo + 1;
      const copy = { ...latest, revisionNo, parentRevisionId: header.latestRevisionId, confirmedAt: null };
      const version = header.version + 1;
      tx.create(revisionPath(type, id, revisionId), copy);
      tx.update(reportPath(type, id), {
        status: 'DRAFT',
        version,
        updatedAt: ctx.now,
        latestRevisionId: revisionId,
        latestRevisionNo: revisionNo,
        documentId: null,
        documentStatus: null,
      });
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: `${LABEL[type].target}_REVISE`,
          targetType: LABEL[type].target,
          targetId: id,
          beforeData: { status: header.status, version: header.version, revisionId: header.latestRevisionId, revisionNo: latest.revisionNo },
          afterData: { status: 'DRAFT', version, revisionId, revisionNo, parentRevisionId: header.latestRevisionId },
          reason: cmd.reason,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: 'DRAFT', version, documentStatus: null, type, businessDate: header.businessDate, revisionNo };
    });
  }

  /**
   * CHG-007 API-013 transitionRecord `approve` / `reject` / `revoke`（FR-007、REQ-APR-001。APPROVAL_ENABLED のときだけ handler が呼ぶ）。
   *   approve: SUBMITTED（帳票作成済みの現在版）→ APPROVED。コメント任意
   *   reject : SUBMITTED → REJECTED。理由 1〜1000字必須。所有者（現場）または事務所が revise で新しい版を作って直す
   *   revoke : APPROVED（請求確定前）→ REVOKED。理由必須
   * 状態・権限・理由は domain の RECORD_TRANSITIONS で判定し、version を照合して +1。判断は header.decision と監査に残す。
   */
  async decide(type: FieldReportType, id: string, action: DecisionAction, cmd: { expectedVersion: number; reason: string | null }, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      const header = await readHeader(tx, type, id);
      if (header === null) throw notFound(type);
      if (header.version !== cmd.expectedVersion) {
        throw new FieldError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: header.version, changedFields: ['/status'] });
      }
      if ((action === 'approve' || action === 'reject') && header.currentRevisionId !== header.latestRevisionId) {
        throw stateConflict(header, '現在の確定版だけを承認・差戻しできます。');
      }
      const roles = ctx.actor.roles.filter((r): r is RecordRole => ['FIELD', 'OFFICE', 'ADMIN', 'AUDITOR'].includes(r));
      const result = resolveRecordTransition(header.status as Parameters<typeof resolveRecordTransition>[0], DECISION_COMMAND[action], { roles, isOwner: false }, cmd.reason ?? undefined);
      if (!result.ok) {
        if (result.errorCode === 'STATE_CONFLICT') {
          throw stateConflict(header, action === 'revoke' ? '承認済み（請求確定前）の報告だけを取り消せます。' : '提出済み（帳票作成済み）の報告だけを承認・差戻しできます。');
        }
        if (result.errorCode === 'FORBIDDEN') throw new FieldError(403, 'FORBIDDEN', 'この操作を行う権限がありません。');
        throw invalid([{ path: '/reason', code: 'required', message: '理由を入力してください。' }]);
      }
      const version = header.version + 1;
      const decision: RecordDecision = { action, reason: cmd.reason, at: ctx.now, actorId: ctx.actor.userId, revisionNo: header.latestRevisionNo };
      tx.update(reportPath(type, id), { status: result.to, version, updatedAt: ctx.now, decision });
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: `${LABEL[type].target}_${DECISION_AUDIT[action]}`,
          targetType: LABEL[type].target,
          targetId: id,
          beforeData: { status: header.status, version: header.version, revisionNo: header.latestRevisionNo },
          afterData: { status: result.to, version, revisionNo: header.latestRevisionNo },
          ...(cmd.reason !== null ? { reason: cmd.reason } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: result.to, version, documentStatus: header.documentStatus, type, businessDate: header.businessDate, revisionNo: header.latestRevisionNo };
    });
  }

  /**
   * CHG-004 D2: 運搬費（運搬報告1件に1金額）を事務所が後から入力・修正する。版は作らず header の version と監査で管理。
   * 下書き中は PATCH（API-010）で扱う。請求確定済み（BILLING_LOCKED）は変更不可。
   */
  async setDeliveryFee(id: string, cmd: { expectedVersion: number; deliveryFeeYen: number | null; reason?: string | undefined }, ctx: FieldContext): Promise<RecordSummary> {
    return this.store.runTransaction(async (tx) => {
      const header = await readHeader(tx, 'DELIVERY', id);
      if (header === null) throw notFound('DELIVERY');
      if (header.version !== cmd.expectedVersion) {
        throw new FieldError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: header.version, changedFields: ['/deliveryFeeYen'] });
      }
      if (header.status === 'DRAFT' || header.status === 'BILLING_LOCKED') {
        throw stateConflict(header, header.status === 'DRAFT' ? '下書きの運搬費は入力画面で変更してください。' : '請求確定済みのため変更できません。');
      }
      const version = header.version + 1;
      tx.update(reportPath('DELIVERY', id), { deliveryFeeYen: cmd.deliveryFeeYen, version, updatedAt: ctx.now });
      appendAudit(
        tx,
        {
          actorId: ctx.actor.userId,
          action: 'DELIVERY_FEE_UPDATE',
          targetType: LABEL.DELIVERY.target,
          targetId: id,
          beforeData: { deliveryFeeYen: header.deliveryFeeYen, version: header.version },
          afterData: { deliveryFeeYen: cmd.deliveryFeeYen, version },
          ...(cmd.reason !== undefined && cmd.reason.trim() !== '' ? { reason: cmd.reason.trim() } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return { id, reportNo: header.reportNo, status: header.status, version, documentStatus: header.documentStatus, type: 'DELIVERY', businessDate: header.businessDate, revisionNo: header.latestRevisionNo };
    });
  }
}

function revisionToWorkInput(r: WorkRevisionDoc): WorkDraftInput {
  return {
    workDate: r.workDate,
    reporterId: r.reporterId,
    customerId: r.customerId,
    productId: r.productId,
    workTypeId: r.workTypeId,
    lotNo: r.lotNo,
    workerIds: [...r.workerIds],
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    quantity: r.quantity,
    defects: r.defects.map((d) => ({ defectTypeId: d.defectTypeId, quantity: d.quantity })),
    workLocationId: r.workLocationId,
    vehicleId: r.vehicleId,
    remarks: r.remarks,
  };
}

function revisionToDeliveryInput(r: DeliveryRevisionDoc, deliveryFeeYen: number | null): DeliveryDraftInput {
  return {
    deliveryDate: r.deliveryDate,
    driverId: r.driverId,
    customerId: r.customerId,
    items: r.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    vehicleId: r.vehicleId,
    tripCount: r.tripCount,
    deliveryFeeYen,
  };
}

/** audit 用（PII 最小化: ID・数値のみ） */
function summarizeWork(d: Record<string, unknown>): Record<string, unknown> {
  const keys = ['workDate', 'customerId', 'productId', 'workTypeId', 'workerIds', 'startAt', 'endAt', 'quantity', 'defects', 'lotNo', 'workLocationId', 'vehicleId', 'version'];
  // 備考は自由記述のため本文を監査に残さず、有無だけ記録する
  return { ...Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]])), ...('remarks' in d ? { hasRemarks: d['remarks'] !== null } : {}) };
}

function summarizeDelivery(d: Record<string, unknown>): Record<string, unknown> {
  const keys = ['deliveryDate', 'driverId', 'customerId', 'items', 'vehicleId', 'tripCount', 'deliveryFeeYen', 'version'];
  return Object.fromEntries(
    keys
      .filter((k) => k in d)
      .map((k) => [k, k === 'items' ? (d[k] as Array<{ productId: string; quantity: number }>).map((i) => ({ productId: i.productId, quantity: i.quantity })) : d[k]]),
  );
}
