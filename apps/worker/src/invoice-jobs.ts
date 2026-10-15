/**
 * CHG-011 請求書の帳票（鏡 INVOICE_COVER_V1・明細 INVOICE_DETAIL_V1）。
 *  - 値は請求書の snapshot（確定時の合計・お客様、発行時の発行元・発行日・支払期限）と、確定した計算版の明細だけから作る（現在のマスタは読まない）
 *  - 明細: 除外した報告の明細は出さない。0円の明細は出さない（固定費を除く。帳票・メール定義書）
 *  - 鏡・明細の両方が作成済みになったら、請求書と請求 run を ISSUED（発行済み）にする（SYSTEM の issue 遷移）
 */
import { escapeHtml, invoiceDisplayNo, invoiceDocumentsReady, invoicePeriodLabel, resolveBillingTransition, toWareki, yenLabel, type BillingLine, type TemplateType } from '@inspexor/domain';
import {
  billingRunPath,
  documentPath,
  invoicePath,
  readChunks,
  type BillingRunDoc,
  type DocReader,
  type DocTransaction,
  type DocumentJobDoc,
  type InvoiceDoc,
  type JobStatus,
} from '@inspexor/docstore';
import { appendAudit, enqueueEvent } from './db';
import type { DocumentSnapshot } from './templates';

export const INVOICE_TEMPLATES: readonly TemplateType[] = ['INVOICE_COVER_V1', 'INVOICE_DETAIL_V1'];

function jaDate(date: string): string {
  const w = toWareki(date);
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日（${w.weekday}）`;
}

function decimalLabel(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return escapeHtml(value);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 4 });
}

function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** 帳票に出す明細（除外した報告・0円を除く。固定費は0円でも出す）。No は振り直す */
export function invoiceLines(lines: readonly BillingLine[], excludedReportIds: readonly string[]): BillingLine[] {
  const excluded = new Set(excludedReportIds);
  return lines
    .filter((l) => l.reportId === null || !excluded.has(l.reportId))
    .filter((l) => l.amountYen !== 0 || l.lineType === 'FIXED_CHARGE')
    .map((l, i) => ({ ...l, no: i + 1 }));
}

/** 請求書（発行済みの依頼がある）→ 鏡・明細の値 */
export async function invoiceSnapshot(db: DocReader, job: DocumentJobDoc, type: TemplateType): Promise<DocumentSnapshot | null> {
  const invoice = await db.get<InvoiceDoc>(invoicePath(job.reportId));
  if (invoice === null || invoice.issuer === undefined || invoice.issuer === null || !invoice.issueDate || !invoice.dueDate) return null;
  const run = await db.get<{ calcVersion: number } & Record<string, unknown>>(billingRunPath(invoice.billingRunId));
  if (run === null) return null;
  const calc = await db.get<{ chunkCounts: { lines: number } }>(`${billingRunPath(invoice.billingRunId)}/calcs/${invoice.calcVersion}`);
  if (calc === null) return null;
  const displayNo = invoiceDisplayNo(invoice.invoiceNo, invoice.revision);
  const period = `${invoicePeriodLabel(invoice.periodEnd)}（${invoice.periodStart} 〜 ${invoice.periodEnd}）`;
  const fileName = { date: invoice.periodEnd, customerCode: invoice.customerSnapshot.code, reportNo: displayNo, revisionNo: job.revisionNo };
  const base = { reportId: job.reportId, reportNo: displayNo, fileName, mail: null };
  if (type === 'INVOICE_COVER_V1') {
    const i = invoice.issuer;
    const issuer = [
      `<div class="name">${escapeHtml(i.name)}</div>`,
      i.postalCode !== '' || i.address !== '' ? `<div>${i.postalCode !== '' ? `〒${escapeHtml(i.postalCode)} ` : ''}${escapeHtml(i.address)}</div>` : '',
      `<div>TEL ${escapeHtml(i.tel)}${i.fax !== '' ? `　FAX ${escapeHtml(i.fax)}` : ''}</div>`,
      i.email !== '' ? `<div>E-mail ${escapeHtml(i.email)}</div>` : '',
      i.registrationNo !== '' ? `<div>登録番号 ${escapeHtml(i.registrationNo)}</div>` : '',
    ].join('');
    return {
      ...base,
      type: 'INVOICE_COVER_V1',
      values: {
        issuer: { html: issuer },
        customer: `${invoice.customerSnapshot.name} 御中`,
        invoice_no: displayNo,
        issue_date: jaDate(invoice.issueDate),
        due_date: jaDate(invoice.dueDate),
        period,
        subtotal: yenLabel(invoice.subtotalYen),
        tax: yenLabel(invoice.taxYen),
        total: yenLabel(invoice.totalYen),
        bank_note: { html: i.bankNote === '' ? '' : multiline(i.bankNote) },
      },
    };
  }
  const all = await readChunks<BillingLine[]>(db, invoice.billingRunId, invoice.calcVersion, 'lines', calc.chunkCounts.lines);
  const rows = invoiceLines(all, invoice.excludedReportIds)
    .map(
      (l) =>
        `<tr><td class="num">${l.no}</td><td>${escapeHtml(l.businessDate ?? '')}</td><td>${escapeHtml(l.productCode)}${l.reportNo !== null ? `<br><span class="small">${escapeHtml(l.reportNo)}</span>` : ''}</td>` +
        `<td>${escapeHtml(l.description)}</td><td class="num">${decimalLabel(l.quantity)} ${escapeHtml(l.unit)}</td><td class="num">${decimalLabel(l.unitPrice)}</td>` +
        `<td class="num">${l.multiplier === null ? '' : `×${escapeHtml(l.multiplier)}`}</td><td class="num">${yenLabel(l.amountYen)}</td></tr>`,
    )
    .join('');
  return {
    ...base,
    type: 'INVOICE_DETAIL_V1',
    values: {
      invoice_no: displayNo,
      period,
      customer_name: invoice.customerSnapshot.name,
      line_rows: { html: rows === '' ? '<tr><td colspan="8">明細はありません。</td></tr>' : rows },
      subtotal: yenLabel(invoice.subtotalYen),
      tax: yenLabel(invoice.taxYen),
      total: yenLabel(invoice.totalYen),
    },
  };
}

/**
 * 読込段階: 請求書と、もう一方の帳票 job。書込段階で、この job が最新の発行分で両方そろえば請求書・請求 run を ISSUED にする関数を返す
 */
export async function invoiceStatusUpdater(tx: DocTransaction, job: DocumentJobDoc & { id: string }): Promise<{ apply: (status: JobStatus, now: Date) => void }> {
  const invoice = await tx.get<InvoiceDoc>(invoicePath(job.reportId));
  const own = invoice !== null && (invoice.coverDocumentId === job.id || invoice.detailDocumentId === job.id);
  const otherId = invoice === null ? null : invoice.coverDocumentId === job.id ? (invoice.detailDocumentId ?? null) : (invoice.coverDocumentId ?? null);
  const other = otherId === null ? null : await tx.get<DocumentJobDoc>(documentPath(otherId));
  const run = invoice === null ? null : await tx.get<BillingRunDoc>(billingRunPath(invoice.billingRunId));
  return {
    apply: (status, now) => {
      if (invoice === null || !own || status !== 'GENERATED' || invoice.status !== 'FINALIZED') return;
      if (!invoiceDocumentsReady([status, other?.status ?? null])) return;
      tx.update(invoicePath(job.reportId), { status: 'ISSUED', version: invoice.version + 1, issuedAt: now, updatedAt: now });
      if (run !== null && resolveBillingTransition(run.status, 'issue', { roles: ['SYSTEM'] }).ok) {
        tx.update(billingRunPath(invoice.billingRunId), { status: 'ISSUED', version: run.version + 1, updatedAt: now });
      }
      appendAudit(tx, {
        action: 'INVOICE_ISSUED',
        targetType: 'INVOICE',
        targetId: job.reportId,
        beforeData: { status: 'FINALIZED' },
        afterData: { status: 'ISSUED', coverDocumentId: invoice.coverDocumentId ?? null, detailDocumentId: invoice.detailDocumentId ?? null },
        correlationId: job.id,
        occurredAt: now,
      });
      enqueueEvent(tx, { type: 'InvoiceIssued', aggregateType: 'Invoice', aggregateId: job.reportId, correlationId: job.id, causationId: null, occurredAt: now, payload: { invoiceId: job.reportId } });
    },
  };
}
