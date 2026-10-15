/**
 * CHG-011 遅延訂正の調整（FR-019 / 業務要件 §8-4「締後訂正は確定 invoice を変更せず、次期間に source 参照付き調整 line を作る」/ DEC-004）。
 *  登録  : 確定済み（無効化していない）請求書を元に、品番・内容・金額（0 以外、負は値引き）・理由。元の報告（その請求に入った報告）は任意
 *  反映  : 元の締め日の翌日以降に締める、同じお客様の次の請求の計算で明細（ADJUSTMENT）になり、確定で適用済みになる
 *  取消  : 未適用（PENDING）のものだけ（理由必須）
 */
import { randomUUID } from 'node:crypto';
import { adjustmentApplyFrom, invoiceDisplayNo, validateAdjustmentInput, type AdjustmentStatus } from '@inspexor/domain';
import {
  appendAudit,
  billingAdjustmentPath,
  C,
  invoicePath,
  reportPath,
  type BillingAdjustmentDoc,
  type DocStore,
  type InvoiceDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { BillingError, type BillingContext } from './billing-service';
import { adjustmentView, type AdjustmentView } from './invoice-service';

export interface AdjustmentCreateInput {
  readonly sourceInvoiceId: string;
  readonly productId: string;
  readonly description: string;
  readonly amountYen: number;
  readonly reason: string;
  readonly sourceReportId?: string | null;
}

type ProductDoc = { code: string; customerId: string };

export class AdjustmentService {
  constructor(private readonly store: DocStore) {}

  async list(filter: { customerId: string | null; status: AdjustmentStatus | null }): Promise<AdjustmentView[]> {
    const rows = await this.store.query<BillingAdjustmentDoc>(C.billingAdjustments, filter.customerId !== null ? { where: [{ field: 'customerId', op: '==', value: filter.customerId }] } : {});
    return rows
      .filter((r) => filter.status === null || r.data.status === filter.status)
      .sort((a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((r) => adjustmentView(r.id, r.data));
  }

  async create(input: AdjustmentCreateInput, ctx: BillingContext): Promise<AdjustmentView> {
    const issues = validateAdjustmentInput({ amountYen: input.amountYen, description: input.description, reason: input.reason });
    if (issues.length > 0) throw new BillingError(422, 'VALIDATION_ERROR', issues[0]?.message ?? '入力内容を確認してください。', issues);
    const id = randomUUID();
    return this.store.runTransaction(async (tx) => {
      // ---- 読込
      const inv = await tx.get<InvoiceDoc>(invoicePath(input.sourceInvoiceId));
      if (inv === null) throw new BillingError(422, 'VALIDATION_ERROR', '元の請求書が見つかりません。', [{ path: '/sourceInvoiceId', code: 'not_found', message: '元の請求書が見つかりません。' }]);
      if (inv.status === 'VOIDED') {
        throw new BillingError(409, 'STATE_CONFLICT', '無効化した請求書には調整を登録できません（作り直した請求書を元にしてください）。', [{ path: '/sourceInvoiceId', code: 'state', message: '無効化した請求書です。' }]);
      }
      const product = await tx.get<ProductDoc>(`${C.products}/${input.productId}`);
      if (product === null || product.customerId !== inv.customerSnapshot.id) {
        throw new BillingError(422, 'VALIDATION_ERROR', '品番はこのお客様の品番から選んでください。', [{ path: '/productId', code: 'not_found', message: '品番はこのお客様の品番から選んでください。' }]);
      }
      let sourceReportNo: string | null = null;
      const sourceReportId = input.sourceReportId ?? null;
      if (sourceReportId !== null) {
        const work = await tx.get<ReportHeaderDoc & { billingRunId?: string | null }>(reportPath('WORK', sourceReportId));
        const delivery = work === null ? await tx.get<ReportHeaderDoc & { billingRunId?: string | null }>(reportPath('DELIVERY', sourceReportId)) : null;
        const h = work ?? delivery;
        if (h === null || h.billingRunId !== inv.billingRunId) {
          throw new BillingError(422, 'VALIDATION_ERROR', '元の報告はこの請求書に入っている報告から選んでください。', [{ path: '/sourceReportId', code: 'not_found', message: '元の報告はこの請求書に入っている報告から選んでください。' }]);
        }
        sourceReportNo = h.reportNo;
      }
      const doc: BillingAdjustmentDoc = {
        customerId: inv.customerSnapshot.id,
        customerCode: inv.customerSnapshot.code,
        sourceInvoiceId: input.sourceInvoiceId,
        sourceInvoiceNo: invoiceDisplayNo(inv.invoiceNo, inv.revision),
        sourcePeriodEnd: inv.periodEnd,
        applyFrom: adjustmentApplyFrom(inv.periodEnd),
        sourceReportId,
        sourceReportNo,
        productId: input.productId,
        productCode: product.code,
        description: input.description.trim(),
        amountYen: input.amountYen,
        reason: input.reason.trim(),
        status: 'PENDING',
        version: 1,
        appliedRunId: null,
        appliedInvoiceId: null,
        cancelReason: null,
        createdAt: ctx.now,
        createdBy: ctx.actorId,
        updatedAt: ctx.now,
      };
      // ---- 書込
      tx.create(billingAdjustmentPath(id), doc);
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'BILLING_ADJUSTMENT_CREATE',
          targetType: 'BILLING_ADJUSTMENT',
          targetId: id,
          afterData: { sourceInvoiceId: doc.sourceInvoiceId, sourceInvoiceNo: doc.sourceInvoiceNo, productId: doc.productId, amountYen: doc.amountYen, applyFrom: doc.applyFrom, sourceReportId },
          reason: doc.reason,
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return adjustmentView(id, doc);
    });
  }

  async cancel(id: string, cmd: { expectedVersion: number; reason: string }, ctx: BillingContext): Promise<AdjustmentView> {
    if (cmd.reason.trim() === '') throw new BillingError(422, 'VALIDATION_ERROR', '取消の理由を入力してください。', [{ path: '/reason', code: 'required', message: '取消の理由を入力してください。' }]);
    return this.store.runTransaction(async (tx) => {
      const a = await tx.get<BillingAdjustmentDoc>(billingAdjustmentPath(id));
      if (a === null) throw new BillingError(404, 'VALIDATION_ERROR', '調整が見つかりません。', [{ path: '/id', code: 'not_found', message: '調整が見つかりません。' }]);
      if (a.version !== cmd.expectedVersion) {
        throw new BillingError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: a.version, changedFields: [] });
      }
      if (a.status !== 'PENDING') {
        throw new BillingError(409, 'STATE_CONFLICT', a.status === 'APPLIED' ? '請求に適用済みの調整は取り消せません（適用した請求書を無効化すると未適用に戻ります）。' : 'この調整は取消済みです。', [], { currentStatus: a.status });
      }
      const next: BillingAdjustmentDoc = { ...a, status: 'CANCELLED', cancelReason: cmd.reason.trim(), version: a.version + 1, updatedAt: ctx.now };
      tx.update(billingAdjustmentPath(id), { status: 'CANCELLED', cancelReason: next.cancelReason, version: next.version, updatedAt: ctx.now });
      appendAudit(tx, { actorId: ctx.actorId, action: 'BILLING_ADJUSTMENT_CANCEL', targetType: 'BILLING_ADJUSTMENT', targetId: id, beforeData: { status: 'PENDING' }, afterData: { status: 'CANCELLED' }, reason: cmd.reason.trim(), correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
      return adjustmentView(id, next);
    });
  }
}
