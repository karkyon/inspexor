/**
 * CHG-011 請求書（SCR-15 / API-022 getInvoice・API-023 transitionInvoice、FR-013・014・019）。BILLING_ENABLED のときだけ（handler で 404）。
 *
 *  参照   : 請求書の snapshot・帳票（鏡・明細の10分リンク）・送付先（現時点の候補）・送信履歴・明細・調整
 *  発行   : issue。鏡・明細の帳票 job を作る（発行元・発行日・支払期限を snapshot）。worker が両方作れたら ISSUED
 *  送付   : send / resend（理由必須）。宛先は お客様担当者のうち「請求書メール」が有効で、担当品番が空（全品番）か請求の品番を含む人。
 *           宛先は送付時に snapshot。0件・不正は mail job を FAILED_FINAL（RECIPIENT_EMPTY 等）で記録する（業務要件 §5）。送れたら SENT
 *  無効化 : void（理由必須）。請求書・請求 run を VOIDED にし、その請求の報告を承認済みに戻す（BILLING_LOCKED → APPROVED）。
 *           この請求に入れた調整は未適用に戻す。同じお客様・期間の請求を作り直すと請求書の版が +1 になる。
 *           この請求書を元にした調整（未適用・適用済み）があるときは無効化できない（先に調整を取り消す）
 */
import {
  hasHeaderInjection,
  invoiceDisplayNo,
  invoiceDueDate,
  invoiceIssuerFromEnv,
  invoiceMailSubject,
  invoicePeriodLabel,
  normalizeRecipients,
  resolveBillingTransition,
  resolveInvoiceAction,
  resolveRecordTransition,
  toJstParts,
  yenLabel,
  type BillingLine,
  type InvoiceAction,
  type InvoiceJobStatus,
  type RecordStatus,
} from '@inspexor/domain';
import {
  appendAudit,
  billingAdjustmentPath,
  billingCalcPath,
  billingRunPath,
  C,
  documentPath,
  filePath,
  invoicePath,
  mailJobPath,
  readChunks,
  readUniqueOwner,
  releaseUnique,
  reportPath,
  uuidFromKey,
  type BillingAdjustmentDoc,
  type BillingCalcDoc,
  type BillingRunDoc,
  type DocReader,
  type DocStore,
  type DocTransaction,
  type DocumentJobDoc,
  type FileDoc,
  type InvoiceDoc,
  type InvoiceIssuerSnapshot,
  type MailJobDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { signFileUrl } from '../documents/signed-url';
import { BillingError, type BillingContext } from './billing-service';

const UNIQUE_KIND = 'billingRun';
const TEMPLATES = { cover: 'INVOICE_COVER_V1', detail: 'INVOICE_DETAIL_V1' } as const;

export interface InvoiceDocumentView {
  readonly kind: 'COVER' | 'DETAIL';
  readonly id: string;
  readonly templateVersion: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly fileName: string | null;
  readonly url: string | null;
  readonly signedUrlExpiresAt: string | null;
}

export interface InvoiceMailView {
  readonly id: string;
  readonly sendRevision: number;
  readonly status: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly errorCode: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdjustmentView {
  readonly id: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly sourceInvoiceId: string;
  readonly sourceInvoiceNo: string;
  readonly applyFrom: string;
  readonly sourceReportId: string | null;
  readonly sourceReportNo: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly description: string;
  readonly amountYen: number;
  readonly reason: string;
  readonly status: string;
  readonly version: number;
  readonly appliedRunId: string | null;
  readonly appliedInvoiceId: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: string;
}

export interface InvoiceDetail {
  readonly id: string;
  readonly invoiceNo: string;
  readonly baseInvoiceNo: string;
  readonly revision: number;
  readonly status: string;
  readonly version: number;
  readonly billingRunId: string;
  readonly customer: { readonly id: string; readonly code: string; readonly name: string; readonly closingDay: number };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodLabel: string;
  readonly calcVersion: number;
  readonly runHash: string;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly issuer: InvoiceIssuerSnapshot | null;
  readonly issueCount: number;
  readonly issuedAt: string | null;
  readonly sentAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly createdAt: string;
  readonly documents: readonly InvoiceDocumentView[];
  /** 現時点の送付先の候補（送付時に確定する） */
  readonly recipients: readonly string[];
  readonly mails: readonly InvoiceMailView[];
  /** 帳票に出す明細（除外した報告・0円を除く。固定費は0円でも出す） */
  readonly lines: readonly BillingLine[];
  /** この請求書を元にした調整（遅延訂正） */
  readonly adjustments: readonly AdjustmentView[];
  /** この請求に入れた調整 */
  readonly appliedAdjustments: readonly AdjustmentView[];
}

const iso = (d: Date | null | undefined): string | null => (d === null || d === undefined ? null : d.toISOString());

function notFound(): BillingError {
  return new BillingError(404, 'VALIDATION_ERROR', '請求書が見つかりません。', [{ path: '/id', code: 'not_found', message: '請求書が見つかりません。' }]);
}

export function adjustmentView(id: string, a: BillingAdjustmentDoc): AdjustmentView {
  return {
    id,
    customerId: a.customerId,
    customerCode: a.customerCode,
    sourceInvoiceId: a.sourceInvoiceId,
    sourceInvoiceNo: a.sourceInvoiceNo,
    applyFrom: a.applyFrom,
    sourceReportId: a.sourceReportId,
    sourceReportNo: a.sourceReportNo,
    productId: a.productId,
    productCode: a.productCode,
    description: a.description,
    amountYen: a.amountYen,
    reason: a.reason,
    status: a.status,
    version: a.version,
    appliedRunId: a.appliedRunId,
    appliedInvoiceId: a.appliedInvoiceId,
    cancelReason: a.cancelReason,
    createdAt: a.createdAt.toISOString(),
  };
}

/** 帳票に出す明細（worker の invoiceLines と同じ規則） */
function printedLines(lines: readonly BillingLine[], excluded: readonly string[]): BillingLine[] {
  const ex = new Set(excluded);
  return lines
    .filter((l) => l.reportId === null || !ex.has(l.reportId))
    .filter((l) => l.amountYen !== 0 || l.lineType === 'FIXED_CHARGE')
    .map((l, i) => ({ ...l, no: i + 1 }));
}

type ContactDoc = { customerId: string; email: string; active: boolean; sendInvoice: boolean; invoiceProductIds?: readonly string[] };

/** 送付先: お客様担当者のうち請求書メールが有効で、担当品番が空（全品番）か請求の品番を含む人 */
async function invoiceRecipients(db: DocReader, customerId: string, productIds: ReadonlySet<string>): Promise<string[]> {
  const contacts = await db.query<ContactDoc>(C.customerContacts, { where: [{ field: 'customerId', op: '==', value: customerId }] });
  return [
    ...new Set(
      contacts
        .filter((c) => c.data.active && c.data.sendInvoice)
        .filter((c) => (c.data.invoiceProductIds ?? []).length === 0 || (c.data.invoiceProductIds ?? []).some((p) => productIds.has(p)))
        .map((c) => c.data.email.trim().toLowerCase()),
    ),
  ].sort();
}

async function readInvoice(db: DocReader, id: string): Promise<InvoiceDoc> {
  const inv = await db.get<InvoiceDoc>(invoicePath(id));
  if (inv === null) throw notFound();
  return inv;
}

async function lineOf(db: DocReader, inv: InvoiceDoc): Promise<BillingLine[]> {
  const calc = await db.get<BillingCalcDoc>(billingCalcPath(inv.billingRunId, inv.calcVersion));
  if (calc === null) return [];
  return readChunks<BillingLine[]>(db, inv.billingRunId, inv.calcVersion, 'lines', calc.chunkCounts.lines);
}

async function mailsOf(db: DocReader, invoiceId: string): Promise<Array<MailJobDoc & { id: string }>> {
  const rows = await db.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'invoiceId', op: '==', value: invoiceId }] });
  return rows.map((r) => ({ ...r.data, id: r.id })).sort((a, b) => a.sendRevision - b.sendRevision || a.createdAt.getTime() - b.createdAt.getTime());
}

function mailBody(inv: InvoiceDoc, displayNo: string, issuer: InvoiceIssuerSnapshot, names: readonly string[]): string {
  return [
    `${inv.customerSnapshot.name} ご担当者様`,
    '',
    `いつもお世話になっております。${issuer.name}です。`,
    `${invoicePeriodLabel(inv.periodEnd)}の請求書（PDF）をお送りします。`,
    '',
    `請求書番号: ${displayNo}`,
    `対象期間: ${inv.periodStart} 〜 ${inv.periodEnd}`,
    `ご請求金額: ${yenLabel(inv.totalYen)}円（税込）`,
    `お支払期限: ${inv.dueDate ?? ''}`,
    `添付: ${names.join('、')}`,
    '',
    `本メールの内容に関するお問い合わせは、${issuer.name}（TEL ${issuer.tel}）までご連絡ください。`,
    '※本メールは INSPEXOR から自動送信しています。',
  ].join('\r\n');
}

export class InvoiceService {
  constructor(
    private readonly store: DocStore,
    private readonly secret: string,
    private readonly env: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  // ---------------------------------------------------------------- 参照（API-022）

  async get(id: string, now: Date): Promise<InvoiceDetail> {
    const inv = await readInvoice(this.store, id);
    const docIds = [inv.coverDocumentId ?? null, inv.detailDocumentId ?? null];
    const jobs = await this.store.getMany<DocumentJobDoc>(docIds.map((d) => (d === null ? `${C.documents}/-` : documentPath(d))));
    const files = await this.store.getMany<FileDoc>(jobs.map((j) => (j?.fileId ? filePath(j.fileId) : `${C.files}/-`)));
    const documents: InvoiceDocumentView[] = [];
    docIds.forEach((docId, i) => {
      const j = jobs[i];
      if (docId === null || j === null || j === undefined) return;
      const f = files[i];
      const ready = j.status === 'GENERATED' && j.fileId !== null && f !== null && f !== undefined;
      const signed = ready ? signFileUrl(j.fileId as string, now, this.secret) : null;
      documents.push({
        kind: i === 0 ? 'COVER' : 'DETAIL',
        id: docId,
        templateVersion: j.templateVersion,
        status: j.status,
        errorCode: j.errorCode,
        fileName: ready ? ((f as FileDoc).storageKey.split('/').pop() ?? null) : null,
        url: signed?.url ?? null,
        signedUrlExpiresAt: signed?.expiresAt ?? null,
      });
    });
    const lines = await lineOf(this.store, inv);
    const printed = printedLines(lines, inv.excludedReportIds);
    const recipients = await invoiceRecipients(this.store, inv.customerSnapshot.id, new Set(printed.map((l) => l.productId)));
    const mails = await mailsOf(this.store, id);
    const adj = await this.store.query<BillingAdjustmentDoc>(C.billingAdjustments, { where: [{ field: 'customerId', op: '==', value: inv.customerSnapshot.id }] });
    const byTime = (a: { data: BillingAdjustmentDoc }, b: { data: BillingAdjustmentDoc }) => a.data.createdAt.getTime() - b.data.createdAt.getTime();
    return {
      id,
      invoiceNo: invoiceDisplayNo(inv.invoiceNo, inv.revision),
      baseInvoiceNo: inv.invoiceNo,
      revision: inv.revision,
      status: inv.status,
      version: inv.version,
      billingRunId: inv.billingRunId,
      customer: inv.customerSnapshot,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      periodLabel: invoicePeriodLabel(inv.periodEnd),
      calcVersion: inv.calcVersion,
      runHash: inv.runHash,
      subtotalYen: inv.subtotalYen,
      taxYen: inv.taxYen,
      totalYen: inv.totalYen,
      taxRate: inv.taxRate,
      issueDate: inv.issueDate ?? null,
      dueDate: inv.dueDate ?? null,
      issuer: inv.issuer ?? null,
      issueCount: inv.issueCount ?? 0,
      issuedAt: iso(inv.issuedAt),
      sentAt: iso(inv.sentAt),
      voidedAt: iso(inv.voidedAt),
      voidReason: inv.voidReason ?? null,
      createdAt: inv.createdAt.toISOString(),
      documents,
      recipients,
      mails: mails.map((m) => ({
        id: m.id,
        sendRevision: m.sendRevision,
        status: m.status,
        to: [...m.recipients.to],
        subject: m.subject,
        errorCode: m.errorCode,
        reason: m.reason ?? null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      lines: printed,
      adjustments: adj.filter((a) => a.data.sourceInvoiceId === id).sort(byTime).map((a) => adjustmentView(a.id, a.data)),
      appliedAdjustments: adj.filter((a) => a.data.appliedInvoiceId === id).sort(byTime).map((a) => adjustmentView(a.id, a.data)),
    };
  }

  // ---------------------------------------------------------------- 操作（API-023）

  async action(id: string, action: InvoiceAction, cmd: { expectedVersion: number; reason?: string | undefined }, ctx: BillingContext): Promise<InvoiceDetail> {
    const reason = cmd.reason?.trim() ?? '';
    switch (action) {
      case 'issue':
        await this.issue(id, cmd.expectedVersion, reason, ctx);
        break;
      case 'send':
      case 'resend':
        await this.send(id, action, cmd.expectedVersion, reason, ctx);
        break;
      case 'void':
        await this.void(id, cmd.expectedVersion, reason, ctx);
        break;
    }
    return this.get(id, ctx.now);
  }

  private check(inv: InvoiceDoc, expectedVersion: number): void {
    if (inv.version !== expectedVersion) {
      throw new BillingError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: inv.version, changedFields: [] });
    }
  }

  private async state(tx: DocTransaction, id: string, inv: InvoiceDoc, reason: string) {
    const ids = [inv.coverDocumentId ?? null, inv.detailDocumentId ?? null];
    const jobs = await tx.getMany<DocumentJobDoc>(ids.map((d) => (d === null ? `${C.documents}/-` : documentPath(d))));
    const docs = ids.map((d, i) => (d === null ? null : ((jobs[i]?.status ?? null) as InvoiceJobStatus | null)));
    const mails = await mailsOf(tx, id);
    return { jobs, docs, mails, base: { status: inv.status, documents: docs, mails: mails.map((m) => m.status as InvoiceJobStatus), reason: reason === '' ? null : reason } };
  }

  private reject(r: { ok: false; status: number; code: string; path: string; message: string }, inv: InvoiceDoc): never {
    throw new BillingError(r.status, r.code, r.message, [{ path: r.path, code: r.status === 409 ? 'state' : 'required', message: r.message }], { currentStatus: inv.status, currentVersion: inv.version });
  }

  private async issue(id: string, expectedVersion: number, reason: string, ctx: BillingContext): Promise<void> {
    const issuer = invoiceIssuerFromEnv(this.env()['INVOICE_ISSUER_JSON']);
    await this.store.runTransaction(async (tx) => {
      // ---- 読込
      const inv = await readInvoice(tx, id);
      this.check(inv, expectedVersion);
      const s = await this.state(tx, id, inv, reason);
      const r = resolveInvoiceAction('issue', s.base);
      if (!r.ok) this.reject(r, inv);
      const issueCount = (inv.issueCount ?? 0) + 1;
      const keys = { cover: `INV:${TEMPLATES.cover}:${id}:${issueCount}`, detail: `INV:${TEMPLATES.detail}:${id}:${issueCount}` };
      const coverId = uuidFromKey(keys.cover);
      const detailId = uuidFromKey(keys.detail);
      const issueDate = toJstParts(ctx.now).date;
      const dueDate = invoiceDueDate(inv.periodEnd);
      // ---- 書込
      for (const [kind, docId] of [['cover', coverId], ['detail', detailId]] as const) {
        const doc: DocumentJobDoc = {
          documentType: kind === 'cover' ? 'INVOICE_COVER' : 'INVOICE_DETAIL',
          sourceType: 'INVOICE',
          reportType: 'INVOICE',
          reportId: id,
          revisionId: id,
          revisionNo: issueCount,
          templateVersion: TEMPLATES[kind],
          status: 'QUEUED',
          idempotencyKey: keys[kind],
          fileId: null,
          attempts: 0,
          errorCode: null,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        };
        tx.create(documentPath(docId), doc);
      }
      tx.update(invoicePath(id), {
        version: inv.version + 1,
        updatedAt: ctx.now,
        issueCount,
        issueRequestedAt: ctx.now,
        issueRequestedBy: ctx.actorId,
        coverDocumentId: coverId,
        detailDocumentId: detailId,
        issueDate,
        dueDate,
        issuer: { ...issuer },
      });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'INVOICE_ISSUE_REQUEST',
          targetType: 'INVOICE',
          targetId: id,
          beforeData: { status: inv.status, version: inv.version },
          afterData: { issueCount, coverDocumentId: coverId, detailDocumentId: detailId, issueDate, dueDate },
          ...(reason !== '' ? { reason } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
    });
  }

  private async send(id: string, action: 'send' | 'resend', expectedVersion: number, reason: string, ctx: BillingContext): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      // ---- 読込
      const inv = await readInvoice(tx, id);
      this.check(inv, expectedVersion);
      const s = await this.state(tx, id, inv, reason);
      const r = resolveInvoiceAction(action, s.base);
      if (!r.ok) this.reject(r, inv);
      const [cover, detail] = s.jobs;
      if (cover?.status !== 'GENERATED' || detail?.status !== 'GENERATED' || !cover.fileId || !detail.fileId) {
        throw new BillingError(409, 'STATE_CONFLICT', '請求書PDFが作成されていません。', [{ path: '/status', code: 'state', message: '請求書PDFが作成されていません。' }]);
      }
      const files = await tx.getMany<FileDoc>([filePath(cover.fileId), filePath(detail.fileId)]);
      const names = files.map((f) => (f === null ? 'invoice.pdf' : (f.storageKey.split('/').pop() as string)));
      const lines = printedLines(await lineOf(tx, inv), inv.excludedReportIds);
      const emails = await invoiceRecipients(tx, inv.customerSnapshot.id, new Set(lines.map((l) => l.productId)));
      const sendRevision = s.mails.reduce((m, x) => Math.max(m, x.sendRevision), 0) + 1;
      const key = `MAIL:INVOICE:${id}:${sendRevision}`;
      const mailId = uuidFromKey(key);
      const displayNo = invoiceDisplayNo(inv.invoiceNo, inv.revision);
      const subject = invoiceMailSubject(invoicePeriodLabel(inv.periodEnd), displayNo);
      const check = normalizeRecipients(emails);
      // 宛先0件は帳票まで可、送信は FAILED_FINAL（業務要件 §5）。API は受け付け、送信履歴に理由を出す
      const failure = !check.ok ? check.code : hasHeaderInjection(subject) ? 'RECIPIENT_INVALID' : null;
      const issuer = inv.issuer ?? invoiceIssuerFromEnv(this.env()['INVOICE_ISSUER_JSON']);
      // ---- 書込
      const doc: MailJobDoc = {
        documentJobId: inv.coverDocumentId as string,
        documentJobIds: [inv.coverDocumentId as string, inv.detailDocumentId as string],
        invoiceId: id,
        reason: reason === '' ? null : reason,
        requestedBy: ctx.actorId,
        recipients: { to: check.ok ? check.recipients : [], cc: [], bcc: [], text: mailBody(inv, displayNo, issuer, names), attachmentName: names[0] as string, attachmentNames: names },
        subject,
        status: failure === null ? 'QUEUED' : 'FAILED_FINAL',
        sendRevision,
        idempotencyKey: key,
        providerMessageId: null,
        attempts: 0,
        errorCode: failure,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      tx.create(mailJobPath(mailId), doc);
      tx.update(invoicePath(id), { version: inv.version + 1, updatedAt: ctx.now });
      // 監査に宛先・本文は残さない（SEC-017）。件数のみ
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: action === 'send' ? 'INVOICE_SEND_REQUEST' : 'INVOICE_RESEND_REQUEST',
          targetType: 'INVOICE',
          targetId: id,
          beforeData: { status: inv.status, version: inv.version },
          afterData: { mailJobId: mailId, sendRevision, recipientCount: check.ok ? check.recipients.length : 0, errorCode: failure },
          ...(reason !== '' ? { reason } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
    });
  }

  private async void(id: string, expectedVersion: number, reason: string, ctx: BillingContext): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      // ---- 読込
      const inv = await readInvoice(tx, id);
      this.check(inv, expectedVersion);
      const s = await this.state(tx, id, inv, reason);
      const r = resolveInvoiceAction('void', s.base);
      if (!r.ok) this.reject(r, inv);
      const run = await tx.get<BillingRunDoc>(billingRunPath(inv.billingRunId));
      if (run === null) throw notFound();
      const runTo = resolveBillingTransition(run.status, 'void', { roles: ctx.roles.filter((x): x is 'OFFICE' | 'ADMIN' => x === 'OFFICE' || x === 'ADMIN') });
      if (!runTo.ok) throw new BillingError(409, 'STATE_CONFLICT', `請求の状態（${run.status}）では無効化できません。`, [], { currentStatus: run.status });
      const adjustments = await tx.query<BillingAdjustmentDoc>(C.billingAdjustments, { where: [{ field: 'customerId', op: '==', value: inv.customerSnapshot.id }] });
      const blocking = adjustments.filter((a) => a.data.sourceInvoiceId === id && a.data.status !== 'CANCELLED');
      if (blocking.length > 0) {
        const message = `この請求書を元にした調整が ${blocking.length} 件あります。先に調整を取り消してください（適用済みの調整は、適用した請求書を先に無効化してください）。`;
        throw new BillingError(409, 'STATE_CONFLICT', message, [{ path: '/adjustments', code: 'exists', message }], { adjustmentIds: blocking.map((a) => a.id) });
      }
      const applied = adjustments.filter((a) => a.data.appliedInvoiceId === id && a.data.status === 'APPLIED');
      const locked = [
        ...(await tx.query<ReportHeaderDoc>(C.workReports, { where: [{ field: 'billingRunId', op: '==', value: inv.billingRunId }] })).map((h) => ({ type: 'WORK' as const, h })),
        ...(await tx.query<ReportHeaderDoc>(C.deliveryReports, { where: [{ field: 'billingRunId', op: '==', value: inv.billingRunId }] })).map((h) => ({ type: 'DELIVERY' as const, h })),
      ].filter((x) => x.h.data.status === 'BILLING_LOCKED');
      for (const l of locked) {
        const t = resolveRecordTransition(l.h.data.status as RecordStatus, 'billingUnlock', { roles: ['SYSTEM'], isOwner: false });
        if (!t.ok) throw new BillingError(409, 'STATE_CONFLICT', `報告 ${l.h.data.reportNo} を承認済みに戻せません。`);
      }
      const owner = await readUniqueOwner(tx, UNIQUE_KIND, run.customerId, run.periodEnd);
      // ---- 書込
      for (const l of locked) {
        tx.update(reportPath(l.type, l.h.id), { status: 'APPROVED', version: l.h.data.version + 1, updatedAt: ctx.now, billingRunId: null });
      }
      for (const a of applied) {
        tx.update(billingAdjustmentPath(a.id), { status: 'PENDING', appliedRunId: null, appliedInvoiceId: null, version: a.data.version + 1, updatedAt: ctx.now });
      }
      if (owner === inv.billingRunId) releaseUnique(tx, UNIQUE_KIND, run.customerId, run.periodEnd);
      tx.update(billingRunPath(inv.billingRunId), { status: runTo.to, version: run.version + 1, updatedAt: ctx.now, voidedAt: ctx.now, voidedBy: ctx.actorId, voidReason: reason });
      tx.update(invoicePath(id), { status: 'VOIDED', version: inv.version + 1, updatedAt: ctx.now, voidedAt: ctx.now, voidedBy: ctx.actorId, voidReason: reason });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'INVOICE_VOID',
          targetType: 'INVOICE',
          targetId: id,
          beforeData: { status: inv.status, version: inv.version, runStatus: run.status },
          afterData: { status: 'VOIDED', billingRunId: inv.billingRunId, unlockedReportIds: locked.map((l) => l.h.id), reopenedAdjustmentIds: applied.map((a) => a.id) },
          reason,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
    });
  }
}
