/**
 * CHG-009 請求（BILLING_ENABLED）の文書形。
 *
 *  billingRuns/{runId}                           請求 run（お客様×請求期間。取消以外は1件: uniqueKeys billingRun:{customerId}:{periodEnd}）
 *  billingRuns/{runId}/calcs/{calcVersion}       計算結果（再計算ごとに新しい版。旧結果は残す）。警告と処置（review）を持つ
 *  billingRuns/{runId}/calcs/{calcVersion}/chunks/{kind}-{n}  明細・計算入力の JSON（1文書 1MiB の上限のため分割）
 *  invoices/{invoiceId}                          請求書（確定時に作る snapshot。CHG-011: 発行・PDF・送付・無効化）
 *  billingAdjustments/{id}                       CHG-011 遅延訂正の調整（確定済みの請求書を変えず、次の請求の明細にする）
 *
 * 明細・入力は入れ子配列を含むため JSON 文字列で保存する（Firestore は配列の入れ子不可）。
 */
import type { DocReader, DocTransaction } from './types';
import { C } from './repos';

export type BillingRunStatus = 'OPEN' | 'CALCULATING' | 'CALCULATED' | 'NEEDS_REVIEW' | 'REVIEWED' | 'FINALIZED' | 'ISSUED' | 'SENT' | 'VOIDED';
export type WarningResolution = 'ACCEPT' | 'EXCLUDE';

export interface BillingRunDoc {
  readonly customerId: string;
  /** 作成時の お客様（表示用。計算時に更新） */
  readonly customerCode: string;
  readonly customerName: string;
  readonly closingDay: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: BillingRunStatus;
  readonly version: number;
  /** 0 = 未計算 */
  readonly calcVersion: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  // ---- 現在の計算版の要約（review の除外を反映した金額）
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly lineCount: number;
  readonly warningCount: number;
  /** 処置していない警告の数 */
  readonly openWarningCount: number;
  readonly sourceCount: number;
  /** 対象期間にあるが承認されていない報告の数（請求に含まれない。画面で注意する） */
  readonly unapprovedCount: number;
  readonly excludedReportIds: readonly string[];
  readonly runHash: string | null;
  readonly ruleHash: string | null;
  readonly algorithmVersion: string | null;
  readonly calculatedAt: Date | null;
  readonly calculatedBy: string | null;
  /** 計算中に戻す先（計算の失敗時） */
  readonly statusBeforeCalc: BillingRunStatus | null;
  readonly reviewedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly reviewReason: string | null;
  readonly finalizedAt: Date | null;
  readonly finalizedBy: string | null;
  readonly invoiceId: string | null;
  readonly voidedAt: Date | null;
  readonly voidedBy: string | null;
  readonly voidReason: string | null;
}

export interface WarningDisposition {
  readonly resolution: WarningResolution;
  readonly reason: string;
  readonly by: string;
  readonly at: Date;
}

/** 警告（engine の BillingWarning を保存。detail は JSON 文字列） */
export interface StoredWarning {
  readonly id: string;
  readonly code: string;
  readonly sourceType: string;
  readonly reportId: string | null;
  readonly reportNo: string | null;
  readonly revisionId: string | null;
  readonly businessDate: string | null;
  readonly productId: string | null;
  readonly productCode: string | null;
  readonly message: string;
  readonly detailJson: string;
  readonly disposition: WarningDisposition | null;
}

export interface BillingCalcDoc {
  readonly calcVersion: number;
  readonly algorithmVersion: string;
  readonly calculatedAt: Date;
  readonly calculatedBy: string;
  readonly runHash: string;
  readonly ruleHash: string;
  readonly inputHash: string;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly lineCount: number;
  readonly warnings: readonly StoredWarning[];
  /** 計算に使った実績（報告ID・版）。確定時に現在版と照合する */
  readonly sources: ReadonlyArray<{ readonly type: 'WORK' | 'DELIVERY'; readonly reportId: string; readonly revisionId: string }>;
  readonly chunkCounts: { readonly lines: number; readonly input: number };
  /** CHG-011: 明細に入れた調整（確定時に未適用のままかを照合し、適用済みにする） */
  readonly adjustmentIds?: readonly string[];
}

export type InvoiceStatus = 'FINALIZED' | 'ISSUED' | 'SENT' | 'VOIDED';

export interface InvoiceDoc {
  readonly billingRunId: string;
  readonly invoiceNo: string;
  readonly revision: number;
  readonly status: InvoiceStatus;
  readonly version: number;
  readonly customerSnapshot: { readonly id: string; readonly code: string; readonly name: string; readonly closingDay: number };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly calcVersion: number;
  readonly runHash: string;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly lineCount: number;
  readonly excludedReportIds: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
  // ---- CHG-011 発行・送付・無効化（旧データには無い）
  /** 発行（PDF 作成）の依頼回数。帳票 job の冪等 key と版に使う */
  readonly issueCount?: number;
  readonly issueRequestedAt?: Date | null;
  readonly issueRequestedBy?: string | null;
  /** 鏡・明細の帳票 job（最新の発行分） */
  readonly coverDocumentId?: string | null;
  readonly detailDocumentId?: string | null;
  /** 発行日（JST の日付）・支払期限・発行元（発行時に snapshot） */
  readonly issueDate?: string | null;
  readonly dueDate?: string | null;
  readonly issuer?: InvoiceIssuerSnapshot | null;
  readonly issuedAt?: Date | null;
  readonly sentAt?: Date | null;
  readonly sendCount?: number;
  readonly voidedAt?: Date | null;
  readonly voidedBy?: string | null;
  readonly voidReason?: string | null;
  /** この請求に入れた調整（確定時に適用済みにしたもの） */
  readonly appliedAdjustmentIds?: readonly string[];
}

export interface InvoiceIssuerSnapshot {
  readonly name: string;
  readonly postalCode: string;
  readonly address: string;
  readonly tel: string;
  readonly fax: string;
  readonly email: string;
  readonly registrationNo: string;
  readonly bankNote: string;
}

export type AdjustmentStatus = 'PENDING' | 'APPLIED' | 'CANCELLED';

/** CHG-011 遅延訂正の調整（FR-019）。元の請求書は変えない */
export interface BillingAdjustmentDoc {
  readonly customerId: string;
  readonly customerCode: string;
  readonly sourceInvoiceId: string;
  /** 版付きの請求書番号（INV-YYYYMM-code-NNN） */
  readonly sourceInvoiceNo: string;
  readonly sourcePeriodEnd: string;
  /** この日以降に締める請求に入れる（元の締め日の翌日） */
  readonly applyFrom: string;
  readonly sourceReportId: string | null;
  readonly sourceReportNo: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly description: string;
  readonly amountYen: number;
  readonly reason: string;
  readonly status: AdjustmentStatus;
  readonly version: number;
  readonly appliedRunId: string | null;
  readonly appliedInvoiceId: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly updatedAt: Date;
}

export const billingAdjustmentPath = (id: string): string => `${C.billingAdjustments}/${id}`;

export const billingRunPath = (runId: string): string => `${C.billingRuns}/${runId}`;
export const billingCalcCollection = (runId: string): string => `${billingRunPath(runId)}/calcs`;
export const billingCalcPath = (runId: string, calcVersion: number): string => `${billingCalcCollection(runId)}/${calcVersion}`;
export const billingChunkPath = (runId: string, calcVersion: number, kind: 'lines' | 'input', index: number): string =>
  `${billingCalcPath(runId, calcVersion)}/chunks/${kind}-${String(index).padStart(4, '0')}`;
export const invoicePath = (invoiceId: string): string => `${C.invoices}/${invoiceId}`;

/** 1文書に入れる文字数（日本語 3 byte/字 でも 1MiB 未満） */
export const CHUNK_CHARS = 250_000;

export function splitChunks(json: string, size: number = CHUNK_CHARS): string[] {
  const out: string[] = [];
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size));
  return out.length === 0 ? [''] : out;
}

/** transaction の書込段階で JSON を分割して保存し、分割数を返す */
export function writeChunks(tx: DocTransaction, runId: string, calcVersion: number, kind: 'lines' | 'input', value: unknown): number {
  const parts = splitChunks(JSON.stringify(value));
  parts.forEach((json, i) => tx.set(billingChunkPath(runId, calcVersion, kind, i), { json }));
  return parts.length;
}

export async function readChunks<T>(db: DocReader, runId: string, calcVersion: number, kind: 'lines' | 'input', count: number): Promise<T> {
  const docs = await db.getMany<{ json: string }>(Array.from({ length: count }, (_, i) => billingChunkPath(runId, calcVersion, kind, i)));
  if (docs.some((d) => d === null)) throw new Error(`billing chunks missing: ${runId}/${calcVersion}/${kind}`);
  return JSON.parse(docs.map((d) => d?.json ?? '').join('')) as T;
}
