/**
 * 帳票 job（FR-005 / REQ-DOC-001 / CHG-003）:
 *   revision snapshot → template（version 固定・registry の sha256 照合）→ placeholder 置換 → 未置換検査
 *   → PDF（Chromium）→ 20MB 検査 → storage → 読み戻し hash 照合 → files / GENERATED（＋CONFIRMED→SUBMITTED）
 *   → 日報は mail job（宛先 snapshot）。失敗は retry（network/5xx 相当）か FAILED_FINAL。record は失敗でも保持。
 */
import { createHash, randomUUID } from 'node:crypto';
import { decideRetry, documentFileName, findUnresolvedPlaceholders, MAIL_MAX_TOTAL_BYTES, renderTemplate, type TemplateType } from '@inspexor/domain';
import { appendAudit, enqueueEvent, withTransaction, type Pool, type PoolClient } from './db';
import { CLAIMABLE_SQL } from './jobs-common';
import { createDailyMailJob } from './mail-jobs';
import { AdapterError, type PdfRenderer, type StorageAdapter } from './ports';
import { deliverySnapshot, ensureRegistered, loadFixtureTemplate, workSnapshot, type DocumentSnapshot } from './templates';

export interface DocumentDeps {
  readonly pool: Pool;
  readonly storage: StorageAdapter;
  readonly pdf: PdfRenderer;
  readonly now: () => Date;
  readonly templateDir?: string;
}

interface JobRow {
  id: string;
  document_type: string;
  source_type: string;
  source_id: string;
  template_version: TemplateType;
  idempotency_key: string;
  attempts: number;
}

class FinalFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function claim(pool: Pool, now: Date): Promise<JobRow | null> {
  return withTransaction(pool, async (client) => {
    const r = await client.query<JobRow>(
      `SELECT id, document_type, source_type, source_id, template_version, idempotency_key, attempts
         FROM app.document_jobs WHERE ${CLAIMABLE_SQL} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), 'PROCESSING'],
    );
    const job = r.rows[0];
    if (job === undefined) return null;
    const u = await client.query<{ attempts: number }>(
      `UPDATE app.document_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at = $2 WHERE id = $1 RETURNING attempts`,
      [job.id, now.toISOString()],
    );
    return { ...job, attempts: u.rows[0]?.attempts ?? job.attempts + 1 };
  });
}

const HEADER: Record<string, { table: string; aggregate: string; target: string }> = {
  WORK_REVISION: { table: 'work_reports', aggregate: 'Work', target: 'WORK_REPORT' },
  DELIVERY_REVISION: { table: 'delivery_reports', aggregate: 'Delivery', target: 'DELIVERY_REPORT' },
};

async function submitRecord(client: PoolClient, job: JobRow, snapshot: DocumentSnapshot, now: Date): Promise<boolean> {
  const h = HEADER[job.source_type];
  if (h === undefined) return false;
  // RECORD_TRANSITIONS: CONFIRMED --documentGenerated(SYSTEM, PDF hash 有)--> SUBMITTED。current revision の帳票のみ
  const r = await client.query<{ version: number }>(
    `UPDATE app.${h.table} SET status = 'SUBMITTED', version = version + 1, updated_at = $3
      WHERE id = $1 AND status = 'CONFIRMED' AND current_revision_id = $2 RETURNING version`,
    [snapshot.reportId, job.source_id, now.toISOString()],
  );
  const version = r.rows[0]?.version;
  if (version === undefined) return false;
  await appendAudit(client, {
    action: 'RECORD_SUBMIT',
    targetType: h.target,
    targetId: snapshot.reportId,
    beforeData: { status: 'CONFIRMED' },
    afterData: { status: 'SUBMITTED', version, documentJobId: job.id },
    correlationId: job.id,
    occurredAt: now,
  });
  await enqueueEvent(client, {
    eventId: randomUUID(),
    type: 'RecordSubmitted',
    aggregateType: h.aggregate,
    aggregateId: snapshot.reportId,
    correlationId: job.id,
    causationId: null,
    occurredAt: now,
    payload: { reportId: snapshot.reportId, revisionId: job.source_id, version, documentJobId: job.id },
  });
  return true;
}

export async function processOneDocumentJob(deps: DocumentDeps): Promise<'none' | 'generated' | 'retry' | 'final'> {
  const job = await claim(deps.pool, deps.now());
  if (job === null) return 'none';
  try {
    const snapshot = job.source_type === 'WORK_REVISION' ? await workSnapshot(deps.pool, job.source_id) : await deliverySnapshot(deps.pool, job.source_id);
    if (snapshot === null || snapshot.type !== job.template_version) throw new FinalFailure('SOURCE_NOT_FOUND', '確定済み revision が見つかりません');
    let template;
    try {
      template = loadFixtureTemplate(job.template_version, deps.templateDir);
    } catch (error) {
      throw new FinalFailure('TEMPLATE_INVALID', String(error));
    }
    if ((await ensureRegistered(deps.pool, template, deps.now())) !== 'ok') throw new FinalFailure('TEMPLATE_INVALID', 'template の sha256 が registry と一致しません');
    const html = renderTemplate(template.html, snapshot.values);
    const unresolved = findUnresolvedPlaceholders(html);
    if (unresolved.length > 0) throw new FinalFailure('TEMPLATE_INVALID', `未置換 placeholder: ${unresolved.join(', ')}`);
    const pdf = await deps.pdf.render(html);
    if (pdf.byteLength > MAIL_MAX_TOTAL_BYTES) throw new FinalFailure('FILE_TOO_LARGE', `PDF が上限を超えています（${pdf.byteLength} bytes）`);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const fileName = documentFileName(job.template_version, snapshot.fileName);
    const storageKey = `documents/${job.document_type}/${snapshot.reportNo}/${job.id}/${fileName}`;
    await deps.storage.put(storageKey, pdf, 'application/pdf');
    const readBack = await deps.storage.get(storageKey);
    if (createHash('sha256').update(readBack.bytes).digest('hex') !== sha256) throw new FinalFailure('HASH_MISMATCH', '保存した PDF の hash が一致しません');

    const now = deps.now();
    await withTransaction(deps.pool, async (client) => {
      const f = await client.query<{ id: string }>(
        `INSERT INTO app.files (storage_key, mime_type, size_bytes, sha256, classification) VALUES ($1, 'application/pdf', $2, $3, 'CONFIDENTIAL') RETURNING id`,
        [storageKey, pdf.byteLength, sha256],
      );
      const fileId = f.rows[0]?.id as string;
      await client.query(`UPDATE app.document_jobs SET status = 'GENERATED', file_id = $2, error_code = NULL, updated_at = $3 WHERE id = $1`, [job.id, fileId, now.toISOString()]);
      await appendAudit(client, {
        action: 'DOCUMENT_GENERATED',
        targetType: 'DOCUMENT_JOB',
        targetId: job.id,
        afterData: { template: job.template_version, revisionId: job.source_id, fileId, sha256, sizeBytes: pdf.byteLength, attempts: job.attempts },
        correlationId: job.id,
        occurredAt: now,
      });
      await enqueueEvent(client, {
        eventId: randomUUID(),
        type: 'DocumentGenerated',
        aggregateType: 'Document',
        aggregateId: job.id,
        correlationId: job.id,
        causationId: null,
        occurredAt: now,
        payload: { documentJobId: job.id, fileId, sha256, reportId: snapshot.reportId, revisionId: job.source_id },
      });
      await submitRecord(client, job, snapshot, now);
      // 日報メールは自動生成分のみ（手動再生成は送らない。送る場合は documentAction send）
      if (snapshot.mail !== null && job.idempotency_key.endsWith(':auto')) {
        await createDailyMailJob(client, { documentJobId: job.id, snapshot, fileName, sendRevision: 1, reason: null }, now);
      }
    });
    return 'generated';
  } catch (error) {
    const final = error instanceof FinalFailure;
    const retryable = error instanceof AdapterError && error.retryable;
    const code = final ? error.code : error instanceof AdapterError ? error.code : 'DEPENDENCY_UNAVAILABLE';
    const outcome = decideRetry(job.attempts, !final && (retryable || !(error instanceof AdapterError)));
    const now = deps.now();
    await withTransaction(deps.pool, async (client) => {
      await client.query(`UPDATE app.document_jobs SET status = $2, error_code = $3, updated_at = $4 WHERE id = $1`, [job.id, outcome.status, code, now.toISOString()]);
      if (outcome.status === 'FAILED_FINAL') {
        await appendAudit(client, {
          action: 'DOCUMENT_FAILED',
          targetType: 'DOCUMENT_JOB',
          targetId: job.id,
          afterData: { template: job.template_version, revisionId: job.source_id, errorCode: code, attempts: job.attempts },
          correlationId: job.id,
          occurredAt: now,
        });
        await enqueueEvent(client, {
          eventId: randomUUID(),
          type: 'DocumentFailed',
          aggregateType: 'Document',
          aggregateId: job.id,
          correlationId: job.id,
          causationId: null,
          occurredAt: now,
          payload: { documentJobId: job.id, errorCode: code, revisionId: job.source_id },
        });
      }
    });
    return outcome.status === 'FAILED_FINAL' ? 'final' : 'retry';
  }
}
