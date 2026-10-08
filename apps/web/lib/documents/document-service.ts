/**
 * API-024 getDocument / API-025 documentAction（G4 / FR-005 / FR-006 / FR-018 / CHG-003）。
 *  - document id = document_jobs.id。参照は OFFICE/ADMIN/AUDITOR、または元実績の所有者（他は 404 で存在秘匿）
 *  - 署名付き URL は file がある（GENERATED）ときだけ、10分（SEC-013）
 *  - action（OFFICE/ADMIN、理由必須）: regenerate=新しい帳票 job、retry=FAILED_FINAL の帳票/メールを新 job で再実行、
 *    send=日報の再送（新 mail job）。job の作成は worker（outbox: DocumentRequested / MailRequested）が行い、旧版は保持
 *  - expectedVersion は元実績（root）の version と照合（document_jobs に version 列が無いため。GAP-019）
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { PgOutboxRepository } from '../db/pg-outbox-repository';
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
  id: string;
  document_type: string;
  source_type: string;
  source_id: string;
  template_version: string;
  status: string;
  error_code: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  file_id: string | null;
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  file_created_at: Date | null;
  report_id: string;
  report_no: string;
  report_status: string;
  report_version: number;
  owner_id: string;
  revision_no: number;
}

const SOURCE = {
  WORK_REVISION: { type: 'WORK', header: 'work_reports', revision: 'work_report_revisions', target: 'WORK_REPORT' },
  DELIVERY_REVISION: { type: 'DELIVERY', header: 'delivery_reports', revision: 'delivery_report_revisions', target: 'DELIVERY_REPORT' },
} as const;

function notFound(): DocumentError {
  // GAP-014: 404 は VALIDATION_ERROR + /id（G2/G3 と同じ）
  return new DocumentError(404, 'VALIDATION_ERROR', '帳票が見つかりません。', [{ path: '/id', code: 'not_found', message: '帳票が見つかりません。' }]);
}

async function load(db: Queryable, id: string, lock: boolean): Promise<DocRow | null> {
  for (const [sourceType, s] of Object.entries(SOURCE)) {
    const r = await db.query<DocRow>(
      `SELECT d.id, d.document_type, d.source_type, d.source_id, d.template_version, d.status::text AS status, d.error_code, d.attempts,
              d.created_at, d.updated_at, d.file_id, f.storage_key, f.mime_type, f.size_bytes, f.sha256, f.created_at AS file_created_at,
              h.id AS report_id, h.report_no, h.status::text AS report_status, h.version AS report_version, h.owner_id, r.revision_no
         FROM app.document_jobs d
         JOIN app.${s.revision} r ON r.id = d.source_id
         JOIN app.${s.header} h ON h.id = r.report_id
         LEFT JOIN app.files f ON f.id = d.file_id
        WHERE d.id = $1 AND d.source_type = $2
        ${lock ? 'FOR UPDATE OF h' : ''}`,
      [id, sourceType],
    );
    if (r.rows[0] !== undefined) return r.rows[0];
  }
  return null;
}

function canRead(actor: DocActor, row: DocRow): boolean {
  return actor.roles.some((r) => ['OFFICE', 'ADMIN', 'AUDITOR'].includes(r)) || row.owner_id === actor.userId;
}

export class DocumentService {
  constructor(private readonly pool: Pool, private readonly secret: string) {}

  async get(id: string, actor: DocActor, now: Date): Promise<Record<string, unknown>> {
    const row = await load(this.pool, id, false);
    if (row === null || !canRead(actor, row)) throw notFound();
    const mails = await this.pool.query<{ id: string; status: string; send_revision: number; attempts: number; error_code: string | null; recipients: { to?: string[] }; updated_at: Date }>(
      `SELECT id, status::text AS status, send_revision, attempts, error_code, recipients, updated_at FROM app.mail_jobs WHERE document_job_id = $1 ORDER BY created_at, id`,
      [id],
    );
    const src = SOURCE[row.source_type as keyof typeof SOURCE];
    const ready = row.status === 'GENERATED' && row.file_id !== null && row.storage_key !== null;
    const signed = ready ? signFileUrl(row.file_id as string, now, this.secret) : null;
    return {
      id: row.id,
      documentType: row.document_type,
      templateVersion: row.template_version,
      status: row.status,
      errorCode: row.error_code,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      source: { type: src.type, reportId: row.report_id, reportNo: row.report_no, revisionId: row.source_id, revisionNo: row.revision_no, reportStatus: row.report_status, reportVersion: row.report_version },
      file: ready
        ? {
            fileName: (row.storage_key as string).split('/').pop(),
            mimeType: row.mime_type,
            sizeBytes: Number(row.size_bytes),
            sha256: row.sha256?.trim(),
            createdAt: row.file_created_at?.toISOString() ?? null,
          }
        : null,
      signedUrl: signed?.url ?? null,
      signedUrlExpiresAt: signed?.expiresAt ?? null,
      // 宛先アドレスは返さない（Privacy by default）。件数のみ
      mails: mails.rows.map((m) => ({
        id: m.id,
        status: m.status,
        sendRevision: m.send_revision,
        attempts: m.attempts,
        errorCode: m.error_code,
        recipientCount: (m.recipients.to ?? []).length,
        updatedAt: m.updated_at.toISOString(),
      })),
    };
  }

  async action(
    id: string,
    action: DocumentAction,
    cmd: { expectedVersion: number; reason?: string | undefined },
    ctx: { actor: DocActor; correlationId: string; now: Date },
  ): Promise<{ requestId: string; action: DocumentAction; status: 'QUEUED' }> {
    const reason = cmd.reason?.trim() ?? '';
    if (reason === '') {
      throw new DocumentError(422, 'VALIDATION_ERROR', '理由を入力してください。', [{ path: '/reason', code: 'required', message: '手動の再生成・再送・再実行は理由が必須です。' }]);
    }
    return withTransaction(this.pool, async (client) => {
      const row = await load(client, id, true);
      if (row === null) throw notFound();
      if (row.report_version !== cmd.expectedVersion) {
        throw new DocumentError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: row.report_version, changedFields: ['/status'] });
      }
      const src = SOURCE[row.source_type as keyof typeof SOURCE];
      if (row.report_status === 'DRAFT') throw new DocumentError(409, 'STATE_CONFLICT', '下書きの帳票は操作できません。', [], { currentVersion: row.report_version });
      const latestMail = await client.query<{ status: string }>(`SELECT status::text AS status FROM app.mail_jobs WHERE document_job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [id]);
      const mailStatus = latestMail.rows[0]?.status ?? null;
      let eventType: 'DocumentRequested' | 'MailRequested';
      let mode: string;
      if (action === 'regenerate') {
        if (['QUEUED', 'PROCESSING', 'FAILED_RETRYABLE'].includes(row.status)) throw new DocumentError(409, 'STATE_CONFLICT', '帳票を作成中です。完了後に操作してください。', [], { currentVersion: row.report_version });
        eventType = 'DocumentRequested';
        mode = 'regenerate';
      } else if (action === 'retry') {
        if (row.status === 'FAILED_FINAL') {
          eventType = 'DocumentRequested';
          mode = 'retry';
        } else if (row.status === 'GENERATED' && mailStatus === 'FAILED_FINAL') {
          eventType = 'MailRequested';
          mode = 'retry';
        } else {
          throw new DocumentError(409, 'STATE_CONFLICT', '再実行できるのは最終失敗した帳票・メールだけです。', [], { currentVersion: row.report_version });
        }
      } else {
        if (src.type !== 'WORK') throw new DocumentError(409, 'STATE_CONFLICT', '運搬実績の帳票はメール送信の対象外です。', [], { currentVersion: row.report_version });
        if (row.status !== 'GENERATED') throw new DocumentError(409, 'STATE_CONFLICT', '帳票が生成されていないため送信できません。', [], { currentVersion: row.report_version });
        if (mailStatus !== null && ['QUEUED', 'SENDING', 'FAILED_RETRYABLE'].includes(mailStatus)) throw new DocumentError(409, 'STATE_CONFLICT', 'メールを送信中です。完了後に操作してください。', [], { currentVersion: row.report_version });
        eventType = 'MailRequested';
        mode = 'send';
      }
      const eventId = randomUUID();
      await new PgOutboxRepository(client).enqueue({
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
            ? { documentJobId: id, revisionId: row.source_id, sourceType: row.source_type, documentType: row.document_type, template: row.template_version, mode, actorId: ctx.actor.userId }
            : { documentJobId: id, mode, actorId: ctx.actor.userId },
      });
      await new PgAuditRepository(client).append({
        actorId: ctx.actor.userId,
        action: `DOCUMENT_${action.toUpperCase()}_REQUEST`,
        targetType: 'DOCUMENT_JOB',
        targetId: id,
        beforeData: { status: row.status, mailStatus },
        afterData: { requestId: eventId, eventType, mode, report: { target: src.target, id: row.report_id } },
        reason,
        correlationId: ctx.correlationId,
        occurredAt: ctx.now,
      });
      return { requestId: eventId, action, status: 'QUEUED' as const };
    });
  }
}
