/**
 * API-024 getDocument / API-025 documentAction（G4 / FR-005 / FR-006 / FR-018 / CHG-003）。
 *  - document id = documents（帳票 job）の ID。CHG-006: Firestore 版。参照は OFFICE/ADMIN/AUDITOR、または元実績の所有者（他は 404 で存在秘匿）
 *  - 署名付き URL は file がある（GENERATED）ときだけ、10分（SEC-013）
 *  - action（OFFICE/ADMIN、理由必須）: regenerate=新しい帳票 job、retry=FAILED_FINAL の帳票/メールを新 job で再実行、
 *    send=日報の再送（新 mail job）。job の作成は worker（outbox: DocumentRequested / MailRequested）が行い、旧版は保持
 *  - expectedVersion は元実績（root）の version と照合（document_jobs に version 列が無いため。GAP-019）
 *  - CHG-004: メール送信は提案書の対象外。mailEnabled=false（既定）では send は未定義の操作（404）、メールの retry も不可
 */
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  C,
  documentPath,
  enqueueOutbox,
  filePath,
  reportPath,
  type DocReader,
  type DocStore,
  type DocumentJobDoc,
  type FileDoc,
  type MailJobDoc,
  type ReportHeaderDoc,
  type ReportType,
} from '@inspexor/docstore';

/** 報告の帳票 job（請求書の帳票は除く。CHG-011） */
type ReportJobDoc = Omit<DocumentJobDoc, 'sourceType' | 'reportType'> & { readonly sourceType: 'WORK_REVISION' | 'DELIVERY_REVISION'; readonly reportType: ReportType };
import { signFileUrl } from './signed-url';

export class DocumentError extends Error {
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

export interface DocActor {
  readonly userId: string;
  readonly roles: readonly string[];
}

export type DocumentAction = 'regenerate' | 'send' | 'retry';
export const DOCUMENT_ACTIONS: readonly DocumentAction[] = ['regenerate', 'send', 'retry'];

interface DocRow {
  readonly id: string;
  readonly job: ReportJobDoc;
  readonly file: FileDoc | null;
  readonly header: ReportHeaderDoc;
}

const SOURCE = {
  WORK_REVISION: { type: 'WORK', target: 'WORK_REPORT' },
  DELIVERY_REVISION: { type: 'DELIVERY', target: 'DELIVERY_REPORT' },
} as const;

function notFound(): DocumentError {
  // GAP-014: 404 は VALIDATION_ERROR + /id（G2/G3 と同じ）
  return new DocumentError(404, 'VALIDATION_ERROR', '帳票が見つかりません。', [{ path: '/id', code: 'not_found', message: '帳票が見つかりません。' }]);
}

async function load(db: DocReader, id: string): Promise<DocRow | null> {
  const raw = await db.get<DocumentJobDoc>(documentPath(id));
  // CHG-011: 請求書の帳票は請求書の画面（API-022）で扱う（この API の対象外）
  if (raw === null || raw.sourceType === 'INVOICE' || raw.reportType === 'INVOICE') return null;
  const job = raw as ReportJobDoc;
  const header = await db.get<ReportHeaderDoc>(reportPath(job.reportType, job.reportId));
  if (header === null) return null;
  const file = job.fileId === null ? null : await db.get<FileDoc>(filePath(job.fileId));
  return { id, job, file, header };
}

async function mailsOf(db: DocReader, id: string): Promise<Array<MailJobDoc & { id: string }>> {
  const rows = await db.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'documentJobId', op: '==', value: id }] });
  return rows.map((r) => ({ ...r.data, id: r.id })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

function canRead(actor: DocActor, row: DocRow): boolean {
  return actor.roles.some((r) => ['OFFICE', 'ADMIN', 'AUDITOR'].includes(r)) || row.header.ownerId === actor.userId;
}

export class DocumentService {
  constructor(
    private readonly store: DocStore,
    private readonly secret: string,
    private readonly mailEnabled = false,
  ) {}

  async get(id: string, actor: DocActor, now: Date): Promise<Record<string, unknown>> {
    const row = await load(this.store, id);
    if (row === null || !canRead(actor, row)) throw notFound();
    const mails = await mailsOf(this.store, id);
    const src = SOURCE[row.job.sourceType];
    const ready = row.job.status === 'GENERATED' && row.job.fileId !== null && row.file !== null;
    const signed = ready ? signFileUrl(row.job.fileId as string, now, this.secret) : null;
    return {
      id: row.id,
      documentType: row.job.documentType,
      templateVersion: row.job.templateVersion,
      status: row.job.status,
      errorCode: row.job.errorCode,
      attempts: row.job.attempts,
      createdAt: row.job.createdAt.toISOString(),
      updatedAt: row.job.updatedAt.toISOString(),
      source: {
        type: src.type,
        reportId: row.job.reportId,
        reportNo: row.header.reportNo,
        revisionId: row.job.revisionId,
        revisionNo: row.job.revisionNo,
        reportStatus: row.header.status,
        reportVersion: row.header.version,
      },
      file:
        ready && row.file !== null
          ? {
              fileName: row.file.storageKey.split('/').pop(),
              mimeType: row.file.mimeType,
              sizeBytes: row.file.sizeBytes,
              sha256: row.file.sha256,
              createdAt: row.file.createdAt.toISOString(),
            }
          : null,
      signedUrl: signed?.url ?? null,
      signedUrlExpiresAt: signed?.expiresAt ?? null,
      // 宛先アドレスは返さない（Privacy by default）。件数のみ
      mails: mails.map((m) => ({
        id: m.id,
        status: m.status,
        sendRevision: m.sendRevision,
        attempts: m.attempts,
        errorCode: m.errorCode,
        recipientCount: m.recipients.to.length,
        updatedAt: m.updatedAt.toISOString(),
      })),
    };
  }

  async action(
    id: string,
    action: DocumentAction,
    cmd: { expectedVersion: number; reason?: string | undefined },
    ctx: { actor: DocActor; correlationId: string; now: Date },
  ): Promise<{ requestId: string; action: DocumentAction; status: 'QUEUED' }> {
    if (action === 'send' && !this.mailEnabled) {
      throw new DocumentError(404, 'VALIDATION_ERROR', '未定義の操作です。', [{ path: '/action', code: 'enum', message: 'regenerate / retry のいずれかです。' }]);
    }
    const reason = cmd.reason?.trim() ?? '';
    if (reason === '') {
      throw new DocumentError(422, 'VALIDATION_ERROR', '理由を入力してください。', [{ path: '/reason', code: 'required', message: '手動の再生成・再送・再実行は理由が必須です。' }]);
    }
    return this.store.runTransaction(async (tx) => {
      const row = await load(tx, id);
      if (row === null) throw notFound();
      const reportVersion = row.header.version;
      if (reportVersion !== cmd.expectedVersion) {
        throw new DocumentError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: reportVersion, changedFields: ['/status'] });
      }
      const src = SOURCE[row.job.sourceType];
      if (row.header.status === 'DRAFT') throw new DocumentError(409, 'STATE_CONFLICT', '下書きの帳票は操作できません。', [], { currentVersion: reportVersion });
      const mails = await mailsOf(tx, id);
      const mailStatus = mails[mails.length - 1]?.status ?? null;
      let eventType: 'DocumentRequested' | 'MailRequested';
      let mode: string;
      if (action === 'regenerate') {
        if (['QUEUED', 'PROCESSING', 'FAILED_RETRYABLE'].includes(row.job.status)) throw new DocumentError(409, 'STATE_CONFLICT', '帳票を作成中です。完了後に操作してください。', [], { currentVersion: reportVersion });
        eventType = 'DocumentRequested';
        mode = 'regenerate';
      } else if (action === 'retry') {
        if (row.job.status === 'FAILED_FINAL') {
          eventType = 'DocumentRequested';
          mode = 'retry';
        } else if (this.mailEnabled && row.job.status === 'GENERATED' && mailStatus === 'FAILED_FINAL') {
          eventType = 'MailRequested';
          mode = 'retry';
        } else {
          throw new DocumentError(409, 'STATE_CONFLICT', '再実行できるのは最終失敗した帳票・メールだけです。', [], { currentVersion: reportVersion });
        }
      } else {
        if (src.type !== 'WORK') throw new DocumentError(409, 'STATE_CONFLICT', '運搬実績の帳票はメール送信の対象外です。', [], { currentVersion: reportVersion });
        if (row.job.status !== 'GENERATED') throw new DocumentError(409, 'STATE_CONFLICT', '帳票が生成されていないため送信できません。', [], { currentVersion: reportVersion });
        if (mailStatus !== null && ['QUEUED', 'SENDING', 'FAILED_RETRYABLE'].includes(mailStatus)) throw new DocumentError(409, 'STATE_CONFLICT', 'メールを送信中です。完了後に操作してください。', [], { currentVersion: reportVersion });
        eventType = 'MailRequested';
        mode = 'send';
      }
      const eventId = randomUUID();
      enqueueOutbox(tx, {
        eventId,
        type: eventType,
        version: 1,
        occurredAt: ctx.now.toISOString(),
        aggregateType: 'Document',
        aggregateId: id,
        correlationId: ctx.correlationId,
        causationId: null,
        payload:
          eventType === 'DocumentRequested'
            ? { documentJobId: id, revisionId: row.job.revisionId, sourceType: row.job.sourceType, documentType: row.job.documentType, template: row.job.templateVersion, mode, actorId: ctx.actor.userId }
            : { documentJobId: id, mode, actorId: ctx.actor.userId },
      }, ctx.now);
      appendAudit(tx, {
        actorId: ctx.actor.userId,
        action: `DOCUMENT_${action.toUpperCase()}_REQUEST`,
        targetType: 'DOCUMENT_JOB',
        targetId: id,
        beforeData: { status: row.job.status, mailStatus },
        afterData: { requestId: eventId, eventType, mode, report: { target: src.target, id: row.job.reportId } },
        reason,
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      }, ctx.now);
      return { requestId: eventId, action, status: 'QUEUED' as const };
    });
  }
}
