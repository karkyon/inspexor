/**
 * 帳票 job・ファイル・メール job・テンプレート登録の文書形（CHG-006 §3。PostgreSQL の document_jobs / files / mail_jobs / template_versions）。
 * job の ID は冪等 key から決める（同じ key の job は1件: PostgreSQL の UNIQUE(idempotency_key) の代わり）。
 */
import { createHash } from 'node:crypto';
import { C } from './repos';
import type { ReportType } from './reports';

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'GENERATED' | 'SENDING' | 'SENT' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';

export interface DocumentJobDoc {
  readonly documentType: string;
  /** CHG-011: INVOICE は請求書の鏡・明細（reportId = 請求書 ID、revisionId = 請求書 ID、revisionNo = 発行回） */
  readonly sourceType: 'WORK_REVISION' | 'DELIVERY_REVISION' | 'INVOICE';
  readonly reportType: ReportType | 'INVOICE';
  readonly reportId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly templateVersion: string;
  readonly status: JobStatus;
  readonly idempotencyKey: string;
  readonly fileId: string | null;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FileDoc {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly classification: string;
  readonly createdAt: Date;
}

export interface MailSnapshotDoc {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly text: string;
  readonly attachmentName: string;
  /** CHG-011: 請求書は鏡・明細の2件（documentJobIds と同じ順） */
  readonly attachmentNames?: readonly string[];
}

export interface MailJobDoc {
  /** 日報: 帳票 job。請求書: 鏡の帳票 job（添付は documentJobIds） */
  readonly documentJobId: string;
  /** CHG-011: 請求書の送付（鏡・明細を添付） */
  readonly invoiceId?: string | null;
  readonly documentJobIds?: readonly string[];
  /** CHG-011: 再送の理由・操作した利用者（送信履歴の表示用） */
  readonly reason?: string | null;
  readonly requestedBy?: string | null;
  readonly recipients: MailSnapshotDoc;
  readonly subject: string;
  readonly status: JobStatus;
  readonly sendRevision: number;
  readonly idempotencyKey: string;
  readonly providerMessageId: string | null;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TemplateVersionDoc {
  readonly templateType: string;
  readonly version: string;
  readonly providerTemplateId: string;
  readonly sha256: string;
  readonly activeFrom: Date;
}

/** 冪等 key → 決定的な UUID（v5 形式。API の id は uuid 形式のため） */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(`inspexor:${key}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const documentPath = (id: string): string => `${C.documents}/${id}`;
export const filePath = (id: string): string => `${C.files}/${id}`;
export const mailJobPath = (id: string): string => `${C.mailJobs}/${id}`;
export const templateVersionPath = (type: string, version: string): string => `${C.templateVersions}/${type}:${version}`;
