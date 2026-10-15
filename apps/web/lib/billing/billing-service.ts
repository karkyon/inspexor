/**
 * CHG-009 請求計算・レビュー・確定（SCR-14 / API-019〜021・API-034、FR-009〜014）。BILLING_ENABLED のときだけ（handler で 404）。
 *
 *  作成   : お客様＋締め日（periodEnd）→ 請求期間（前締め翌日〜当締め日）。お客様×期間で取消以外は1件（uniqueKeys）
 *  計算   : 承認済み（APPROVED）の現在版だけを対象に、計算エンジン（@inspexor/domain calculateBilling）で明細・警告・税を作る。
 *           CALCULATING → 警告なし CALCULATED / あり NEEDS_REVIEW。再計算は新しい計算版（calcVersion）を作り、旧結果を残す
 *  レビュー: すべての警告に処置（ACCEPT=そのまま／EXCLUDE=その報告を請求から除外）と理由 → REVIEWED
 *  確定   : 計算に使った版が今も現在版で承認済みか、期間内に新しく承認された報告が無いかを照合（違えば 409 SOURCE_CHANGED → 再計算）。
 *           請求書（snapshot）を作り、対象の報告を BILLING_LOCKED にする（除外した報告は残す）
 *  取消   : 確定前の run を VOIDED（理由必須）。同じ期間で作り直せる。確定後は請求書の無効化（CHG-011、invoice-service）
 *  調整   : CHG-011 遅延訂正。お客様の未適用の調整（元の締め日の翌日以降に締める請求）を計算に入れ、確定で適用済みにする
 *  すべての操作は version 照合・監査記録。計算は request 内で同期に行う（1お客様×1か月は数百件規模）
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  BILLING_ALGORITHM_VERSION,
  BILLING_TAX_RATE,
  billingPeriodFor,
  calculateBilling,
  canonicalJson,
  closingDateForMonth,
  invoiceDisplayNo,
  resolveBillingTransition,
  resolveRecordTransition,
  totalsOf,
  type BillingCommand,
  type BillingEngineInput,
  type BillingLine,
  type BillingRole,
  type EngineAdjustment,
  type EngineDeliverySource,
  type EngineFixedCharge,
  type EngineProduct,
  type EngineRateRule,
  type EngineTransportRule,
  type EngineWorkSource,
  type RecordStatus,
} from '@inspexor/domain';
import {
  appendAudit,
  billingAdjustmentPath,
  billingCalcCollection,
  billingCalcPath,
  billingRunPath,
  C,
  claimUnique,
  invoicePath,
  readChunks,
  readCounter,
  readUniqueOwner,
  releaseUnique,
  reportPath,
  revisionPath,
  writeChunks,
  writeCounter,
  type BillingAdjustmentDoc,
  type BillingCalcDoc,
  type BillingRunDoc,
  type BillingRunStatus,
  type DeliveryCurrent,
  type DocReader,
  type DocStore,
  type DocTransaction,
  type InvoiceDoc,
  type ReportHeaderDoc,
  type StoredWarning,
  type WarningResolution,
  type WorkCurrent,
  type WorkRevisionDoc,
} from '@inspexor/docstore';

export class BillingError extends Error {
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

export interface BillingContext {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly correlationId: string;
  readonly now: Date;
}

export interface BillingRunView {
  readonly id: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly closingDay: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: BillingRunStatus;
  readonly version: number;
  readonly calcVersion: number;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly lineCount: number;
  readonly warningCount: number;
  readonly openWarningCount: number;
  readonly sourceCount: number;
  readonly unapprovedCount: number;
  readonly excludedReportIds: readonly string[];
  readonly runHash: string | null;
  readonly algorithmVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly calculatedAt: string | null;
  readonly reviewedAt: string | null;
  readonly reviewReason: string | null;
  readonly finalizedAt: string | null;
  readonly invoiceId: string | null;
  readonly invoiceNo: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
}

export interface BillingWarningView extends Omit<StoredWarning, 'detailJson' | 'disposition'> {
  readonly detail: Record<string, unknown>;
  readonly disposition: { readonly resolution: WarningResolution; readonly reason: string; readonly by: string; readonly at: string } | null;
}

export interface BillingRunDetail extends BillingRunView {
  /** 表示している計算版（0 = 未計算） */
  readonly viewingCalcVersion: number;
  readonly lines: readonly BillingLine[];
  readonly warnings: readonly BillingWarningView[];
  readonly calcs: ReadonlyArray<{ readonly calcVersion: number; readonly calculatedAt: string; readonly totalYen: number; readonly warningCount: number; readonly runHash: string }>;
}

const OPEN_STATUSES: readonly BillingRunStatus[] = ['OPEN', 'CALCULATING', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED'];
const STALE_CALC_MS = 10 * 60_000;
const UNIQUE_KIND = 'billingRun';

const iso = (d: Date | null | undefined): string | null => (d === null || d === undefined ? null : d.toISOString());
const sha256 = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

function notFound(): BillingError {
  return new BillingError(404, 'VALIDATION_ERROR', '請求が見つかりません。', [{ path: '/id', code: 'not_found', message: '請求が見つかりません。' }]);
}

function billingRoles(roles: readonly string[]): BillingRole[] {
  return roles.filter((r): r is BillingRole => r === 'OFFICE' || r === 'ADMIN');
}

function toView(id: string, d: BillingRunDoc, invoiceNo: string | null = null): BillingRunView {
  return {
    id,
    customerId: d.customerId,
    customerCode: d.customerCode,
    customerName: d.customerName,
    closingDay: d.closingDay,
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    status: d.status,
    version: d.version,
    calcVersion: d.calcVersion,
    subtotalYen: d.subtotalYen,
    taxYen: d.taxYen,
    totalYen: d.totalYen,
    taxRate: d.taxRate,
    lineCount: d.lineCount,
    warningCount: d.warningCount,
    openWarningCount: d.openWarningCount,
    sourceCount: d.sourceCount,
    unapprovedCount: d.unapprovedCount,
    excludedReportIds: [...d.excludedReportIds],
    runHash: d.runHash,
    algorithmVersion: d.algorithmVersion,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    calculatedAt: iso(d.calculatedAt),
    reviewedAt: iso(d.reviewedAt),
    reviewReason: d.reviewReason,
    finalizedAt: iso(d.finalizedAt),
    invoiceId: d.invoiceId,
    invoiceNo,
    voidedAt: iso(d.voidedAt),
    voidReason: d.voidReason,
  };
}

function warningView(w: StoredWarning): BillingWarningView {
  const { detailJson, disposition, ...rest } = w;
  return {
    ...rest,
    detail: JSON.parse(detailJson) as Record<string, unknown>,
    disposition: disposition === null ? null : { resolution: disposition.resolution, reason: disposition.reason, by: disposition.by, at: disposition.at.toISOString() },
  };
}

async function readRun(db: DocReader, id: string): Promise<BillingRunDoc> {
  const run = await db.get<BillingRunDoc>(billingRunPath(id));
  if (run === null) throw notFound();
  return run;
}

function checkVersion(run: BillingRunDoc, expectedVersion: number): void {
  if (run.version !== expectedVersion) {
    throw new BillingError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: run.version, changedFields: [] });
  }
}

function transition(from: BillingRunStatus, command: BillingCommand, ctx: BillingContext, hasWarnings?: boolean): BillingRunStatus {
  const r = resolveBillingTransition(from, command, { roles: command === 'complete' ? ['SYSTEM'] : billingRoles(ctx.roles) }, hasWarnings === undefined ? undefined : { hasWarnings });
  if (!r.ok) {
    const label: Record<string, string> = { calculate: '計算', review: 'レビューの完了', finalize: '確定', void: '取消', complete: '計算の完了' };
    throw new BillingError(r.errorCode === 'FORBIDDEN' ? 403 : 409, r.errorCode, r.errorCode === 'FORBIDDEN' ? r.message : `この状態（${from}）では${label[command] ?? command}できません。`, [], { currentStatus: from });
  }
  return r.to;
}

interface LoadedSources {
  readonly input: BillingEngineInput;
  readonly unapprovedCount: number;
  readonly customer: { code: string; name: string; closingDay: number };
}

type CustomerDoc = { code: string; name: string; closingDay: number; active: boolean };
type ProductDoc = { code: string; name: string; customerId: string; settlementType: 'QUANTITY' | 'TIME'; active: boolean };

/** 期間内の報告（確定済みの現在版）のうち、お客様の承認済みと未承認（請求に含まれない）を分ける */
async function periodHeaders(db: DocReader, customerId: string, start: string, end: string) {
  const read = async (collection: string) =>
    (
      await db.query<ReportHeaderDoc>(collection, {
        where: [
          { field: 'current.businessDate', op: '>=', value: start },
          { field: 'current.businessDate', op: '<=', value: end },
        ],
      })
    ).filter((r) => r.data.current !== null && r.data.current.customerId === customerId);
  const work = await read(C.workReports);
  const delivery = await read(C.deliveryReports);
  const approved = (rows: typeof work) => rows.filter((r) => r.data.status === 'APPROVED');
  const unapproved = [...work, ...delivery].filter((r) => r.data.status !== 'APPROVED' && r.data.status !== 'BILLING_LOCKED').length;
  return { work: approved(work), delivery: approved(delivery), unapproved };
}

/** CHG-011: お客様の未適用の調整のうち、この締め日の請求に入れるもの（元の締め日の翌日以降に締める請求） */
async function pendingAdjustments(db: DocReader, customerId: string, periodEnd: string): Promise<EngineAdjustment[]> {
  const rows = await db.query<BillingAdjustmentDoc>(C.billingAdjustments, { where: [{ field: 'customerId', op: '==', value: customerId }] });
  return rows
    .filter((r) => r.data.status === 'PENDING' && r.data.applyFrom <= periodEnd)
    .map((r) => ({ id: r.id, productId: r.data.productId, description: r.data.description, amountYen: r.data.amountYen, sourceInvoiceNo: r.data.sourceInvoiceNo, sourceReportNo: r.data.sourceReportNo }));
}

export class BillingService {
  constructor(private readonly store: DocStore) {}

  // ---------------------------------------------------------------- 参照

  async list(filter: { customerId: string | null; status: BillingRunStatus | null }): Promise<BillingRunView[]> {
    const rows = await this.store.query<BillingRunDoc>(C.billingRuns, filter.customerId !== null ? { where: [{ field: 'customerId', op: '==', value: filter.customerId }] } : {});
    const invoiceIds = rows.map((r) => r.data.invoiceId).filter((x): x is string => x !== null);
    const invoices = invoiceIds.length === 0 ? [] : await this.store.getMany<InvoiceDoc>(invoiceIds.map(invoicePath));
    const invoiceNo = new Map(invoiceIds.map((id, i) => {
      const inv = invoices[i];
      return [id, inv === null || inv === undefined ? null : invoiceDisplayNo(inv.invoiceNo, inv.revision)];
    }));
    return rows
      .filter((r) => filter.status === null || r.data.status === filter.status)
      .sort((a, b) => (a.data.periodEnd < b.data.periodEnd ? 1 : a.data.periodEnd > b.data.periodEnd ? -1 : a.data.customerCode.localeCompare(b.data.customerCode) || a.data.createdAt.getTime() - b.data.createdAt.getTime()))
      .map((r) => toView(r.id, r.data, r.data.invoiceId === null ? null : (invoiceNo.get(r.data.invoiceId) ?? null)));
  }

  async get(id: string, calcVersion: number | null = null): Promise<BillingRunDetail> {
    const run = await readRun(this.store, id);
    const calcs = (await this.store.query<BillingCalcDoc>(billingCalcCollection(id))).map((c) => c.data).sort((a, b) => a.calcVersion - b.calcVersion);
    const viewing = calcVersion ?? run.calcVersion;
    const calc = calcs.find((c) => c.calcVersion === viewing) ?? null;
    if (calcVersion !== null && calc === null) {
      throw new BillingError(404, 'VALIDATION_ERROR', '計算版が見つかりません。', [{ path: '/query/calcVersion', code: 'not_found', message: '計算版が見つかりません。' }]);
    }
    const lines = calc === null ? [] : await readChunks<BillingLine[]>(this.store, id, calc.calcVersion, 'lines', calc.chunkCounts.lines);
    const invoice = run.invoiceId === null ? null : await this.store.get<InvoiceDoc>(invoicePath(run.invoiceId));
    return {
      ...toView(id, run, invoice === null ? null : invoiceDisplayNo(invoice.invoiceNo, invoice.revision)),
      viewingCalcVersion: calc?.calcVersion ?? 0,
      lines,
      warnings: (calc?.warnings ?? []).map(warningView),
      calcs: calcs.map((c) => ({ calcVersion: c.calcVersion, calculatedAt: c.calculatedAt.toISOString(), totalYen: c.totalYen, warningCount: c.warnings.length, runHash: c.runHash })),
    };
  }

  // ---------------------------------------------------------------- 作成

  async create(input: { customerId: string; periodEnd: string }, ctx: BillingContext): Promise<BillingRunView> {
    const id = randomUUID();
    return this.store.runTransaction(async (tx) => {
      const customer = await tx.get<CustomerDoc>(`${C.customers}/${input.customerId}`);
      if (customer === null) {
        throw new BillingError(422, 'VALIDATION_ERROR', 'お客様が見つかりません。', [{ path: '/customerId', code: 'not_found', message: 'お客様が見つかりません。' }]);
      }
      if (!customer.active) {
        throw new BillingError(422, 'MASTER_INACTIVE', 'お客様は無効化されています。', [{ path: '/customerId', code: 'inactive', message: 'お客様は無効化されています。' }]);
      }
      const period = billingPeriodFor(customer.closingDay, input.periodEnd);
      if (period === null) {
        const month = input.periodEnd.slice(0, 7);
        const example = /^\d{4}-\d{2}$/.test(month) ? closingDateForMonth(month, customer.closingDay) : null;
        const message = `締め日ではありません（${customer.closingDay === 31 ? '月末' : `${customer.closingDay}日`}締め${example !== null ? `。この月の締め日は ${example}` : ''}）。`;
        throw new BillingError(422, 'VALIDATION_ERROR', message, [{ path: '/periodEnd', code: 'closing_day', message }]);
      }
      const existing = await readUniqueOwner(tx, UNIQUE_KIND, input.customerId, period.end);
      if (existing !== null) {
        throw new BillingError(409, 'STATE_CONFLICT', 'このお客様・請求期間の請求は既にあります。', [{ path: '/periodEnd', code: 'duplicate', message: 'このお客様・請求期間の請求は既にあります。' }], { existingRunId: existing });
      }
      const doc: BillingRunDoc = {
        customerId: input.customerId,
        customerCode: customer.code,
        customerName: customer.name,
        closingDay: customer.closingDay,
        periodStart: period.start,
        periodEnd: period.end,
        status: 'OPEN',
        version: 1,
        calcVersion: 0,
        createdAt: ctx.now,
        createdBy: ctx.actorId,
        updatedAt: ctx.now,
        subtotalYen: 0,
        taxYen: 0,
        totalYen: 0,
        taxRate: BILLING_TAX_RATE,
        lineCount: 0,
        warningCount: 0,
        openWarningCount: 0,
        sourceCount: 0,
        unapprovedCount: 0,
        excludedReportIds: [],
        runHash: null,
        ruleHash: null,
        algorithmVersion: null,
        calculatedAt: null,
        calculatedBy: null,
        statusBeforeCalc: null,
        reviewedAt: null,
        reviewedBy: null,
        reviewReason: null,
        finalizedAt: null,
        finalizedBy: null,
        invoiceId: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      };
      claimUnique(tx, UNIQUE_KIND, input.customerId, period.end, id);
      tx.create(billingRunPath(id), doc);
      appendAudit(tx, { actorId: ctx.actorId, action: 'BILLING_RUN_CREATE', targetType: 'BILLING_RUN', targetId: id, afterData: { customerId: doc.customerId, periodStart: doc.periodStart, periodEnd: doc.periodEnd }, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
      return toView(id, doc);
    });
  }

  // ---------------------------------------------------------------- 計算

  /** 計算の入力（承認済み実績の現在版・お客様の品番・有効なルール）。現在のマスタはここでだけ読み、入力 snapshot として保存する */
  private async loadInput(run: BillingRunDoc): Promise<LoadedSources> {
    const db = this.store;
    const customer = await db.get<CustomerDoc>(`${C.customers}/${run.customerId}`);
    if (customer === null) throw new BillingError(422, 'VALIDATION_ERROR', 'お客様が見つかりません。');
    const productRows = await db.query<ProductDoc>(C.products, { where: [{ field: 'customerId', op: '==', value: run.customerId }] });
    const products: EngineProduct[] = productRows.map((p) => ({ id: p.id, code: p.data.code, name: p.data.name, settlementType: p.data.settlementType }));
    const productIds = new Set(products.map((p) => p.id));
    const rules = async <T>(collection: string) =>
      (await db.query<Record<string, unknown> & { active: boolean; productId: string }>(collection)).filter((r) => r.data.active && productIds.has(r.data.productId)).map((r) => ({ id: r.id, ...r.data }) as unknown as T);
    const rateRules = (await rules<EngineRateRule & { active?: boolean }>(C.rateRules)).map((r) => ({ id: r.id, productId: r.productId, workTypeId: r.workTypeId ?? null, unitPrice: r.unitPrice, overtimeMultiplier: r.overtimeMultiplier ?? '1.25', validFrom: r.validFrom, validTo: r.validTo ?? null }));
    const transportRules = (await rules<EngineTransportRule>(C.transportRules)).map((r) => ({ id: r.id, productId: r.productId, workTypeId: r.workTypeId ?? null, transportType: r.transportType, amountYen: r.amountYen, allocationGroup: r.allocationGroup ?? null, validFrom: r.validFrom, validTo: r.validTo ?? null }));
    const fixedCharges = (await rules<EngineFixedCharge>(C.fixedChargeRules)).map((r) => ({ id: r.id, productId: r.productId, label: r.label, amountYen: r.amountYen, validFrom: r.validFrom, validTo: r.validTo ?? null }));

    const headers = await periodHeaders(db, run.customerId, run.periodStart, run.periodEnd);
    const revisions = await db.getMany<WorkRevisionDoc>(headers.work.map((h) => revisionPath('WORK', h.id, (h.data.current as WorkCurrent).revisionId)));
    const workTypeIds = [...new Set(headers.work.map((h) => (h.data.current as WorkCurrent).workTypeId))];
    const workTypes = await db.getMany<{ name: string }>(workTypeIds.map((id) => `${C.workTypes}/${id}`));
    const workTypeName = new Map(workTypeIds.map((id, i) => [id, workTypes[i]?.name ?? '（不明な作業内容）']));
    const work: EngineWorkSource[] = headers.work.map((h, i) => {
      const c = h.data.current as WorkCurrent;
      const rev = revisions[i];
      if (rev === null || rev === undefined) throw new Error(`work revision missing: ${h.id}/${c.revisionId}`);
      return {
        reportId: h.id,
        reportNo: h.data.reportNo,
        revisionId: c.revisionId,
        revisionNo: c.revisionNo,
        businessDate: c.businessDate,
        productId: c.productId,
        workTypeId: c.workTypeId,
        workTypeName: workTypeName.get(c.workTypeId) ?? '',
        quantity: rev.quantity,
        regularPersonMinutes: rev.regularPersonMinutes,
        overtimePersonMinutes: rev.overtimePersonMinutes,
      };
    });
    const deliveries: EngineDeliverySource[] = headers.delivery.map((h) => {
      const c = h.data.current as DeliveryCurrent;
      return {
        reportId: h.id,
        reportNo: h.data.reportNo,
        revisionId: c.revisionId,
        revisionNo: c.revisionNo,
        businessDate: c.businessDate,
        tripCount: c.tripCount,
        deliveryFeeYen: h.data.deliveryFeeYen,
        items: c.items.map((x) => ({ productId: x.productId, quantity: x.quantity })),
      };
    });
    // 実績の品番がお客様の品番に無い（移管等）場合も名称を出せるよう足す
    const missing = [...new Set([...work.map((w) => w.productId), ...deliveries.flatMap((d) => d.items.map((x) => x.productId))])].filter((pid) => !productIds.has(pid));
    if (missing.length > 0) {
      const docs = await db.getMany<ProductDoc>(missing.map((pid) => `${C.products}/${pid}`));
      missing.forEach((pid, i) => {
        const p = docs[i];
        if (p !== null && p !== undefined) products.push({ id: pid, code: p.code, name: p.name, settlementType: p.settlementType });
      });
    }
    const adjustments = await pendingAdjustments(db, run.customerId, run.periodEnd);
    for (const a of adjustments) {
      if (!products.some((p) => p.id === a.productId)) {
        const doc = await db.get<ProductDoc>(`${C.products}/${a.productId}`);
        if (doc !== null) products.push({ id: a.productId, code: doc.code, name: doc.name, settlementType: doc.settlementType });
      }
    }
    return {
      customer: { code: customer.code, name: customer.name, closingDay: customer.closingDay },
      unapprovedCount: headers.unapproved,
      input: {
        customerId: run.customerId,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        taxRate: BILLING_TAX_RATE,
        products,
        rateRules,
        transportRules,
        fixedCharges,
        work,
        deliveries,
        adjustments,
      },
    };
  }

  async calculate(id: string, cmd: { expectedVersion: number }, ctx: BillingContext): Promise<BillingRunDetail> {
    const started = await this.store.runTransaction(async (tx) => {
      const run = await readRun(tx, id);
      checkVersion(run, cmd.expectedVersion);
      // 計算中のまま止まった run（処理の中断）は、一定時間後に計算前の状態から再計算できる
      const stale = run.status === 'CALCULATING' && ctx.now.getTime() - run.updatedAt.getTime() > STALE_CALC_MS;
      const from: BillingRunStatus = stale ? (run.statusBeforeCalc ?? 'OPEN') : run.status;
      transition(from, 'calculate', ctx);
      tx.update(billingRunPath(id), { status: 'CALCULATING', statusBeforeCalc: from, version: run.version + 1, updatedAt: ctx.now });
      appendAudit(tx, { actorId: ctx.actorId, action: 'BILLING_RUN_CALCULATE', targetType: 'BILLING_RUN', targetId: id, beforeData: { status: run.status, version: run.version }, afterData: { status: 'CALCULATING', version: run.version + 1 }, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
      return { run, from, version: run.version + 1 };
    });
    try {
      const loaded = await this.loadInput(started.run);
      const result = calculateBilling(loaded.input);
      const warnings: StoredWarning[] = result.warnings.map((w) => ({
        id: w.id,
        code: w.code,
        sourceType: w.sourceType,
        reportId: w.reportId,
        reportNo: w.reportNo,
        revisionId: w.revisionId,
        businessDate: w.businessDate,
        productId: w.productId,
        productCode: w.productCode,
        message: w.message,
        detailJson: JSON.stringify(w.detail),
        disposition: null,
      }));
      const usedRules = new Set(result.ruleIds);
      const ruleHash = sha256({
        rates: loaded.input.rateRules.filter((r) => usedRules.has(r.id)),
        transport: loaded.input.transportRules.filter((r) => usedRules.has(r.id)),
        fixed: loaded.input.fixedCharges.filter((r) => usedRules.has(r.id)),
      });
      const runHash = sha256({
        algorithmVersion: result.algorithmVersion,
        customerId: result.customerId,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        lines: result.lines,
        warnings: result.warnings,
        subtotalYen: result.subtotalYen,
        taxYen: result.taxYen,
        totalYen: result.totalYen,
        taxRate: result.taxRate,
      });
      const inputHash = sha256(loaded.input);
      await this.store.runTransaction(async (tx) => {
        const cur = await readRun(tx, id);
        if (cur.status !== 'CALCULATING' || cur.version !== started.version) {
          throw new BillingError(409, 'STATE_CONFLICT', '計算中に請求が更新されました。再読込してください。', [], { currentStatus: cur.status });
        }
        const calcVersion = cur.calcVersion + 1;
        const to = transition('CALCULATING', 'complete', ctx, warnings.length > 0);
        const lineChunks = writeChunks(tx, id, calcVersion, 'lines', result.lines);
        const inputChunks = writeChunks(tx, id, calcVersion, 'input', loaded.input);
        const calc: BillingCalcDoc = {
          calcVersion,
          algorithmVersion: BILLING_ALGORITHM_VERSION,
          calculatedAt: ctx.now,
          calculatedBy: ctx.actorId,
          runHash,
          ruleHash,
          inputHash,
          subtotalYen: result.subtotalYen,
          taxYen: result.taxYen,
          totalYen: result.totalYen,
          taxRate: result.taxRate,
          lineCount: result.lines.length,
          warnings,
          sources: [...result.sources],
          chunkCounts: { lines: lineChunks, input: inputChunks },
          adjustmentIds: [...result.adjustmentIds],
        };
        tx.create(billingCalcPath(id, calcVersion), calc);
        tx.update(billingRunPath(id), {
          status: to,
          statusBeforeCalc: null,
          version: cur.version + 1,
          calcVersion,
          updatedAt: ctx.now,
          customerCode: loaded.customer.code,
          customerName: loaded.customer.name,
          subtotalYen: result.subtotalYen,
          taxYen: result.taxYen,
          totalYen: result.totalYen,
          taxRate: result.taxRate,
          lineCount: result.lines.length,
          warningCount: warnings.length,
          openWarningCount: warnings.length,
          sourceCount: result.sources.length,
          unapprovedCount: loaded.unapprovedCount,
          excludedReportIds: [],
          runHash,
          ruleHash,
          algorithmVersion: result.algorithmVersion,
          calculatedAt: ctx.now,
          calculatedBy: ctx.actorId,
          reviewedAt: null,
          reviewedBy: null,
          reviewReason: null,
        });
        appendAudit(
          tx,
          {
            actorId: ctx.actorId,
            action: 'BILLING_RUN_CALCULATED',
            targetType: 'BILLING_RUN',
            targetId: id,
            afterData: { status: to, calcVersion, runHash, ruleHash, inputHash, totalYen: result.totalYen, lineCount: result.lines.length, warningCount: warnings.length, sourceCount: result.sources.length },
            correlationId: ctx.correlationId,
            occurredAt: ctx.now,
          },
          ctx.now,
        );
      });
    } catch (error) {
      await this.store
        .runTransaction(async (tx) => {
          const cur = await readRun(tx, id);
          if (cur.status !== 'CALCULATING' || cur.version !== started.version) return;
          tx.update(billingRunPath(id), { status: started.from, statusBeforeCalc: null, version: cur.version + 1, updatedAt: ctx.now });
          appendAudit(tx, { actorId: ctx.actorId, action: 'BILLING_RUN_CALCULATE_FAILED', targetType: 'BILLING_RUN', targetId: id, afterData: { status: started.from, error: String(error) }, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
        })
        .catch(() => undefined);
      throw error;
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------- レビュー

  async review(id: string, cmd: { expectedVersion: number; reason: string; resolutions: ReadonlyArray<{ warningId: string; resolution: WarningResolution }> }, ctx: BillingContext): Promise<BillingRunDetail> {
    await this.store.runTransaction(async (tx) => {
      const run = await readRun(tx, id);
      checkVersion(run, cmd.expectedVersion);
      const to = transition(run.status, 'review', ctx);
      const calc = await tx.get<BillingCalcDoc>(billingCalcPath(id, run.calcVersion));
      if (calc === null) throw notFound();
      const lines = await readChunks<BillingLine[]>(tx, id, calc.calcVersion, 'lines', calc.chunkCounts.lines);
      const byId = new Map(cmd.resolutions.map((r, i) => [r.warningId, { ...r, index: i }]));
      const fields: Array<{ path: string; code: string; message: string }> = [];
      cmd.resolutions.forEach((r, i) => {
        if (!calc.warnings.some((w) => w.id === r.warningId)) fields.push({ path: `/resolutions/${i}/warningId`, code: 'not_found', message: '警告が見つかりません（再読込してください）。' });
      });
      if (byId.size !== cmd.resolutions.length) fields.push({ path: '/resolutions', code: 'duplicate', message: '同じ警告に複数の処置があります。' });
      calc.warnings.forEach((w) => {
        const r = byId.get(w.id);
        if (r === undefined) fields.push({ path: '/resolutions', code: 'required', message: `処置が選ばれていない警告があります（${w.message}）。` });
        else if (r.resolution === 'EXCLUDE' && w.reportId === null) fields.push({ path: `/resolutions/${r.index}/resolution`, code: 'exclude_not_allowed', message: '報告に結び付かない警告は除外できません（ルールを直して再計算してください）。' });
      });
      if (fields.length > 0) throw new BillingError(422, 'VALIDATION_ERROR', fields[0]?.message ?? '入力内容を確認してください。', fields);
      const disposed = calc.warnings.map((w) => ({ ...w, disposition: { resolution: (byId.get(w.id) as { resolution: WarningResolution }).resolution, reason: cmd.reason, by: ctx.actorId, at: ctx.now } }));
      const excluded = [...new Set(disposed.filter((w) => w.disposition.resolution === 'EXCLUDE' && w.reportId !== null).map((w) => w.reportId as string))].sort();
      const totals = totalsOf(lines, run.taxRate, new Set(excluded));
      tx.update(billingCalcPath(id, calc.calcVersion), { warnings: disposed });
      tx.update(billingRunPath(id), {
        status: to,
        version: run.version + 1,
        updatedAt: ctx.now,
        openWarningCount: 0,
        excludedReportIds: excluded,
        subtotalYen: totals.subtotalYen,
        taxYen: totals.taxYen,
        totalYen: totals.totalYen,
        reviewedAt: ctx.now,
        reviewedBy: ctx.actorId,
        reviewReason: cmd.reason,
      });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'BILLING_RUN_REVIEW',
          targetType: 'BILLING_RUN',
          targetId: id,
          beforeData: { status: run.status, totalYen: run.totalYen },
          afterData: { status: to, calcVersion: calc.calcVersion, resolutions: cmd.resolutions, excludedReportIds: excluded, totalYen: totals.totalYen },
          reason: cmd.reason,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- 確定

  async finalize(id: string, cmd: { expectedVersion: number }, ctx: BillingContext): Promise<BillingRunDetail> {
    await this.store.runTransaction(async (tx) => {
      const run = await readRun(tx, id);
      checkVersion(run, cmd.expectedVersion);
      const to = transition(run.status, 'finalize', ctx);
      const calc = await tx.get<BillingCalcDoc>(billingCalcPath(id, run.calcVersion));
      if (calc === null) throw notFound();
      if (run.totalYen < 0) {
        throw new BillingError(422, 'VALIDATION_ERROR', '請求合計が負のため確定できません。', [{ path: '/', code: 'negative_invoice', message: '請求合計が負のため確定できません。' }]);
      }
      // 計算に使った版が今も承認済みの現在版か（修正・取消・承認取消の検出）
      const headers = await tx.getMany<ReportHeaderDoc>(calc.sources.map((s) => reportPath(s.type, s.reportId)));
      const changed: string[] = [];
      calc.sources.forEach((s, i) => {
        const h = headers[i];
        if (h === null || h === undefined || h.status !== 'APPROVED' || h.current?.revisionId !== s.revisionId) changed.push(h?.reportNo ?? s.reportId);
      });
      // 期間内に新しく承認された報告が無いか
      const now = await periodHeaders(tx, run.customerId, run.periodStart, run.periodEnd);
      const known = new Set(calc.sources.map((s) => s.reportId));
      for (const h of [...now.work, ...now.delivery]) if (!known.has(h.id)) changed.push(h.data.reportNo);
      // CHG-011: 計算に入れた調整が未適用のままか、計算後に新しい調整が登録されていないか
      const usedAdjustments = calc.adjustmentIds ?? [];
      const adjustmentDocs = await tx.getMany<BillingAdjustmentDoc>(usedAdjustments.map(billingAdjustmentPath));
      usedAdjustments.forEach((aid, i) => {
        if (adjustmentDocs[i]?.status !== 'PENDING') changed.push(`調整 ${adjustmentDocs[i]?.description ?? aid}`);
      });
      const usedSet = new Set(usedAdjustments);
      for (const a of await pendingAdjustments(tx, run.customerId, run.periodEnd)) if (!usedSet.has(a.id)) changed.push(`調整 ${a.description}`);
      if (changed.length > 0) {
        const list = [...new Set(changed)].sort();
        throw new BillingError(409, 'SOURCE_CHANGED', `計算後に報告が変わりました（${list.slice(0, 5).join('、')}${list.length > 5 ? ` ほか${list.length - 5}件` : ''}）。再計算してください。`, [], { changedReports: list });
      }
      const customer = await tx.get<CustomerDoc>(`${C.customers}/${run.customerId}`);
      const invoiceNo = `INV-${run.periodEnd.slice(0, 4)}${run.periodEnd.slice(5, 7)}-${customer?.code ?? run.customerCode}`;
      const counterName = `invoiceRevision:${invoiceNo}`;
      const revision = (await readCounter(tx, counterName)) + 1;
      const excluded = new Set(run.excludedReportIds);
      const lock: Array<{ type: 'WORK' | 'DELIVERY'; reportId: string; header: ReportHeaderDoc }> = [];
      calc.sources.forEach((s, i) => {
        if (!excluded.has(s.reportId)) lock.push({ type: s.type, reportId: s.reportId, header: headers[i] as ReportHeaderDoc });
      });
      for (const l of lock) {
        const r = resolveRecordTransition(l.header.status as RecordStatus, 'billingFinalize', { roles: ['SYSTEM'], isOwner: false });
        if (!r.ok) throw new BillingError(409, 'SOURCE_CHANGED', `報告 ${l.header.reportNo} の状態が変わりました。再計算してください。`);
      }

      // ---- 書込
      const invoiceId = randomUUID();
      const invoice: InvoiceDoc = {
        billingRunId: id,
        invoiceNo,
        revision,
        status: 'FINALIZED',
        version: 1,
        customerSnapshot: { id: run.customerId, code: customer?.code ?? run.customerCode, name: customer?.name ?? run.customerName, closingDay: customer?.closingDay ?? run.closingDay },
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        calcVersion: calc.calcVersion,
        runHash: calc.runHash,
        subtotalYen: run.subtotalYen,
        taxYen: run.taxYen,
        totalYen: run.totalYen,
        taxRate: run.taxRate,
        lineCount: calc.lineCount,
        excludedReportIds: [...run.excludedReportIds],
        createdAt: ctx.now,
        createdBy: ctx.actorId,
        updatedAt: ctx.now,
        appliedAdjustmentIds: [...usedAdjustments],
      };
      writeCounter(tx, counterName, revision);
      usedAdjustments.forEach((aid, i) => {
        tx.update(billingAdjustmentPath(aid), { status: 'APPLIED', appliedRunId: id, appliedInvoiceId: invoiceId, version: (adjustmentDocs[i]?.version ?? 0) + 1, updatedAt: ctx.now });
      });
      tx.create(invoicePath(invoiceId), invoice);
      for (const l of lock) {
        tx.update(reportPath(l.type, l.reportId), { status: 'BILLING_LOCKED', version: l.header.version + 1, updatedAt: ctx.now, billingRunId: id });
      }
      tx.update(billingRunPath(id), { status: to, version: run.version + 1, updatedAt: ctx.now, finalizedAt: ctx.now, finalizedBy: ctx.actorId, invoiceId });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'BILLING_RUN_FINALIZE',
          targetType: 'BILLING_RUN',
          targetId: id,
          beforeData: { status: run.status, version: run.version },
          afterData: { status: to, invoiceId, invoiceNo, revision, totalYen: run.totalYen, runHash: calc.runHash, lockedReportIds: lock.map((l) => l.reportId), excludedReportIds: [...excluded] },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- 取消

  async void(id: string, cmd: { expectedVersion: number; reason: string }, ctx: BillingContext): Promise<BillingRunDetail> {
    await this.store.runTransaction(async (tx: DocTransaction) => {
      const run = await readRun(tx, id);
      checkVersion(run, cmd.expectedVersion);
      if (run.status === 'FINALIZED' || run.status === 'ISSUED' || run.status === 'SENT') {
        throw new BillingError(409, 'STATE_CONFLICT', '確定済みの請求は、請求書の画面で無効化してください（報告を承認済みに戻します）。', [], { currentStatus: run.status, invoiceId: run.invoiceId });
      }
      const to = transition(run.status, 'void', ctx);
      const owner = await readUniqueOwner(tx, UNIQUE_KIND, run.customerId, run.periodEnd);
      if (owner === id) releaseUnique(tx, UNIQUE_KIND, run.customerId, run.periodEnd);
      tx.update(billingRunPath(id), { status: to, version: run.version + 1, updatedAt: ctx.now, voidedAt: ctx.now, voidedBy: ctx.actorId, voidReason: cmd.reason });
      appendAudit(tx, { actorId: ctx.actorId, action: 'BILLING_RUN_VOID', targetType: 'BILLING_RUN', targetId: id, beforeData: { status: run.status }, afterData: { status: to }, reason: cmd.reason, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
    });
    return this.get(id);
  }
}

/** マスタ変更の影響（MasterImpact.affectedOpenBillingRunCount）: 確定前の請求 run のうち、お客様と期間が重なるもの */
export async function countOpenBillingRuns(db: DocReader, filter: { customerId: string | null; from: string; to: string | null }): Promise<number> {
  const rows = await db.query<BillingRunDoc>(C.billingRuns, filter.customerId !== null ? { where: [{ field: 'customerId', op: '==', value: filter.customerId }] } : {});
  return rows.filter((r) => OPEN_STATUSES.includes(r.data.status) && r.data.periodEnd >= filter.from && (filter.to === null || r.data.periodStart <= filter.to)).length;
}
