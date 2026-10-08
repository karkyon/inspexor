/**
 * 日報メール（FR-006 / REQ-MAIL-001）:
 *  - 宛先は作成時に snapshot（品番の DAILY 担当かつ send_daily の有効な連絡先）。0件・不正は FAILED_FINAL（帳票は残す）
 *  - 送信前に PDF を storage から読み戻して files.sha256 と照合、20MB 以下
 *  - Message-ID は冪等 key から決定し、送信前に provider を検索（timeout 後に実は送れていた場合の二重送信防止: T-MAIL-001）
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  dailyReportSubject,
  decideRetry,
  hasHeaderInjection,
  MAIL_MAX_ATTACHMENTS,
  MAIL_MAX_TOTAL_BYTES,
  normalizeRecipients,
} from '@inspexor/domain';
import { appendAudit, enqueueEvent, withTransaction, type Pool, type PoolClient, type Queryable } from './db';
import { CLAIMABLE_SQL } from './jobs-common';
import { AdapterError, type MailSender, type StorageAdapter } from './ports';
import type { DocumentSnapshot } from './templates';

export interface MailSnapshot {
  readonly to: string[];
  readonly cc: string[];
  readonly bcc: string[];
  readonly text: string;
  readonly attachmentName: string;
}

export function mailJobKey(documentJobId: string, sendRevision: number): string {
  return `MAIL:DAILY_REPORT:${documentJobId}:${sendRevision}`;
}

export function messageIdOf(idempotencyKey: string): string {
  return `<${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}@mail.inspexor>`;
}

function dailyBody(s: DocumentSnapshot, fileName: string): string {
  const m = s.mail;
  return [
    `${m?.customerName ?? ''} ご担当者様`,
    '',
    'いつもお世話になっております。三成興業株式会社です。',
    '下記の作業結果報告書（PDF）をお送りします。',
    '',
    `作業日: ${m?.workDate ?? ''}`,
    `品番: ${m?.productCode ?? ''} ${m?.productName ?? ''}`,
    `報告番号: ${s.reportNo}`,
    `添付: ${fileName}`,
    '',
    '本メールの内容に関するお問い合わせは、三成興業株式会社の担当者までご連絡ください。',
    '※本メールは INSPEXOR から自動送信しています。',
  ].join('\r\n');
}

/** 帳票生成と同じ transaction で mail job を作る（宛先 snapshot）。宛先0件・不正は FAILED_FINAL で記録 */
export async function createDailyMailJob(
  client: Queryable,
  input: { documentJobId: string; snapshot: DocumentSnapshot; fileName: string; sendRevision: number; reason: string | null; idempotencyKey?: string },
  now: Date,
): Promise<string> {
  const m = input.snapshot.mail;
  if (m === null) throw new Error('mail snapshot required');
  const contacts = await client.query<{ email: string }>(
    `SELECT DISTINCT c.email FROM app.customer_contacts c
       JOIN app.product_contacts pc ON pc.contact_id = c.id AND pc.purpose = 'DAILY'
      WHERE pc.product_id = $1 AND c.customer_id = $2 AND c.active AND c.send_daily
      ORDER BY c.email`,
    [m.productId, m.customerId],
  );
  const check = normalizeRecipients(contacts.rows.map((c) => c.email));
  const subject = dailyReportSubject({ workDate: m.workDate, productCode: m.productCode, reportNo: input.snapshot.reportNo });
  const snapshot: MailSnapshot = {
    to: check.ok ? check.recipients : [],
    cc: [],
    bcc: [],
    text: dailyBody(input.snapshot, input.fileName),
    attachmentName: input.fileName,
  };
  const key = input.idempotencyKey ?? mailJobKey(input.documentJobId, input.sendRevision);
  const failure = !check.ok ? check.code : hasHeaderInjection(subject) ? 'RECIPIENT_INVALID' : null;
  const r = await client.query<{ id: string }>(
    `INSERT INTO app.mail_jobs (document_job_id, recipients, subject, status, send_revision, idempotency_key, error_code)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING id`,
    [input.documentJobId, JSON.stringify(snapshot), subject, failure === null ? 'QUEUED' : 'FAILED_FINAL', input.sendRevision, key, failure],
  );
  const id = r.rows[0]?.id as string;
  if (failure !== null) {
    // 宛先0件は帳票生成まで可、送信は FAILED_FINAL（業務要件 §5）
    await appendAudit(client, { action: 'MAIL_FAILED', targetType: 'MAIL_JOB', targetId: id, afterData: { errorCode: failure, documentJobId: input.documentJobId }, correlationId: input.documentJobId, occurredAt: now });
    await enqueueEvent(client, { eventId: randomUUID(), type: 'MailFailed', aggregateType: 'Mail', aggregateId: id, correlationId: input.documentJobId, causationId: null, occurredAt: now, payload: { mailJobId: id, errorCode: failure } });
  }
  return id;
}

export interface MailDeps {
  readonly pool: Pool;
  readonly storage: StorageAdapter;
  readonly sender: MailSender;
  readonly now: () => Date;
}

interface MailRow {
  id: string;
  document_job_id: string;
  recipients: MailSnapshot;
  subject: string;
  idempotency_key: string;
  attempts: number;
}

class FinalFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function claim(pool: Pool, now: Date): Promise<MailRow | null> {
  return withTransaction(pool, async (client: PoolClient) => {
    const r = await client.query<MailRow>(
      `SELECT id, document_job_id, recipients, subject, idempotency_key, attempts FROM app.mail_jobs
        WHERE ${CLAIMABLE_SQL} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), 'SENDING'],
    );
    const job = r.rows[0];
    if (job === undefined) return null;
    const u = await client.query<{ attempts: number }>(`UPDATE app.mail_jobs SET status = 'SENDING', attempts = attempts + 1, updated_at = $2 WHERE id = $1 RETURNING attempts`, [job.id, now.toISOString()]);
    return { ...job, attempts: u.rows[0]?.attempts ?? job.attempts + 1 };
  });
}

export async function processOneMailJob(deps: MailDeps): Promise<'none' | 'sent' | 'retry' | 'final'> {
  const job = await claim(deps.pool, deps.now());
  if (job === null) return 'none';
  try {
    const doc = await deps.pool.query<{ status: string; storage_key: string | null; sha256: string | null; size_bytes: string | null }>(
      `SELECT d.status, f.storage_key, f.sha256, f.size_bytes FROM app.document_jobs d LEFT JOIN app.files f ON f.id = d.file_id WHERE d.id = $1`,
      [job.document_job_id],
    );
    const d = doc.rows[0];
    if (d === undefined || d.status !== 'GENERATED' || d.storage_key === null || d.sha256 === null) throw new FinalFailure('DOCUMENT_NOT_READY', '帳票が生成されていません');
    const check = normalizeRecipients(job.recipients.to);
    if (!check.ok) throw new FinalFailure(check.code, check.detail);
    if (hasHeaderInjection(job.subject)) throw new FinalFailure('RECIPIENT_INVALID', 'subject header injection');
    const stored = await deps.storage.get(d.storage_key);
    if (createHash('sha256').update(stored.bytes).digest('hex') !== d.sha256.trim()) throw new FinalFailure('HASH_MISMATCH', 'PDF hash 不一致');
    const attachments = [{ filename: job.recipients.attachmentName, contentType: 'application/pdf', bytes: stored.bytes }];
    if (attachments.length > MAIL_MAX_ATTACHMENTS || attachments.reduce((s, a) => s + a.bytes.byteLength, 0) > MAIL_MAX_TOTAL_BYTES) {
      throw new FinalFailure('FILE_TOO_LARGE', '添付が 20MB を超えています');
    }
    const messageId = messageIdOf(job.idempotency_key);
    const providerId =
      (await deps.sender.findSent(messageId)) ??
      (await deps.sender.send({ messageId, to: check.recipients, cc: job.recipients.cc, bcc: job.recipients.bcc, subject: job.subject, text: job.recipients.text, attachments }));
    const now = deps.now();
    await withTransaction(deps.pool, async (client) => {
      await client.query(`UPDATE app.mail_jobs SET status = 'SENT', provider_message_id = $2, error_code = NULL, updated_at = $3 WHERE id = $1`, [job.id, providerId, now.toISOString()]);
      // audit に宛先・本文は残さない（SEC-017）。件数のみ
      await appendAudit(client, { action: 'MAIL_SENT', targetType: 'MAIL_JOB', targetId: job.id, afterData: { documentJobId: job.document_job_id, recipientCount: check.recipients.length, providerMessageId: providerId, attempts: job.attempts }, correlationId: job.document_job_id, occurredAt: now });
      await enqueueEvent(client, { eventId: randomUUID(), type: 'MailSent', aggregateType: 'Mail', aggregateId: job.id, correlationId: job.document_job_id, causationId: null, occurredAt: now, payload: { mailJobId: job.id, providerMessageId: providerId } });
    });
    return 'sent';
  } catch (error) {
    const final = error instanceof FinalFailure;
    const code = final ? error.code : error instanceof AdapterError ? error.code : 'DEPENDENCY_UNAVAILABLE';
    const retryable = !final && (!(error instanceof AdapterError) || error.retryable);
    const outcome = decideRetry(job.attempts, retryable);
    const now = deps.now();
    await withTransaction(deps.pool, async (client) => {
      await client.query(`UPDATE app.mail_jobs SET status = $2, error_code = $3, updated_at = $4 WHERE id = $1`, [job.id, outcome.status, code, now.toISOString()]);
      if (outcome.status === 'FAILED_FINAL') {
        await appendAudit(client, { action: 'MAIL_FAILED', targetType: 'MAIL_JOB', targetId: job.id, afterData: { documentJobId: job.document_job_id, errorCode: code, attempts: job.attempts }, correlationId: job.document_job_id, occurredAt: now });
        await enqueueEvent(client, { eventId: randomUUID(), type: 'MailFailed', aggregateType: 'Mail', aggregateId: job.id, correlationId: job.document_job_id, causationId: null, occurredAt: now, payload: { mailJobId: job.id, errorCode: code } });
      }
    });
    return outcome.status === 'FAILED_FINAL' ? 'final' : 'retry';
  }
}
