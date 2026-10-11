/**
 * 日報メール（FR-006 / REQ-MAIL-001。CHG-004 により既定で無効＝DAILY_MAIL_ENABLED=true のときだけ）。CHG-006: Firestore 版。
 *  - 宛先は作成時に snapshot（品番の DAILY 担当かつ sendDaily の有効な連絡先）。0件・不正は FAILED_FINAL（帳票は残す）
 *  - 送信前に PDF を storage から読み戻して files.sha256 と照合、20MB 以下
 *  - Message-ID は冪等 key から決定し、送信前に provider を検索（timeout 後に実は送れていた場合の二重送信防止: T-MAIL-001）
 */
import { createHash } from 'node:crypto';
import {
  dailyReportSubject,
  decideRetry,
  hasHeaderInjection,
  MAIL_MAX_ATTACHMENTS,
  MAIL_MAX_TOTAL_BYTES,
  normalizeRecipients,
} from '@inspexor/domain';
import {
  C,
  documentPath,
  mailJobPath,
  StorageError,
  uuidFromKey,
  type DocStore,
  type DocTransaction,
  type DocumentJobDoc,
  type FileDoc,
  type MailJobDoc,
  type MailSnapshotDoc,
  type StorageAdapter,
} from '@inspexor/docstore';
import { appendAudit, enqueueEvent } from './db';
import { CLAIM_STATUSES, isClaimable } from './jobs-common';
import { AdapterError, type MailSender } from './ports';
import type { DocumentSnapshot } from './templates';

export type MailSnapshot = MailSnapshotDoc;

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

/**
 * 帳票生成と同じ transaction で mail job を作る（宛先 snapshot）。読込段階で呼び、書込関数を返す（既にあれば null）。
 * 宛先0件・不正は FAILED_FINAL で記録。
 */
export async function prepareDailyMailJob(
  tx: DocTransaction,
  input: { documentJobId: string; snapshot: DocumentSnapshot; fileName: string; sendRevision: number; reason: string | null; idempotencyKey?: string },
  now: Date,
): Promise<(() => void) | null> {
  const m = input.snapshot.mail;
  if (m === null) throw new Error('mail snapshot required');
  const key = input.idempotencyKey ?? mailJobKey(input.documentJobId, input.sendRevision);
  const id = uuidFromKey(key);
  if ((await tx.get(mailJobPath(id))) !== null) return null;
  const contacts = await tx.query<{ email: string; customerId: string; active: boolean; sendDaily: boolean }>(C.customerContacts, {
    where: [{ field: 'dailyProductIds', op: 'array-contains', value: m.productId }],
  });
  const emails = [...new Set(contacts.filter((c) => c.data.customerId === m.customerId && c.data.active && c.data.sendDaily).map((c) => c.data.email))].sort();
  const check = normalizeRecipients(emails);
  const subject = dailyReportSubject({ workDate: m.workDate, productCode: m.productCode, reportNo: input.snapshot.reportNo });
  const snapshot: MailSnapshot = { to: check.ok ? check.recipients : [], cc: [], bcc: [], text: dailyBody(input.snapshot, input.fileName), attachmentName: input.fileName };
  const failure = !check.ok ? check.code : hasHeaderInjection(subject) ? 'RECIPIENT_INVALID' : null;
  return () => {
    const doc: MailJobDoc = {
      documentJobId: input.documentJobId,
      recipients: snapshot,
      subject,
      status: failure === null ? 'QUEUED' : 'FAILED_FINAL',
      sendRevision: input.sendRevision,
      idempotencyKey: key,
      providerMessageId: null,
      attempts: 0,
      errorCode: failure,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(mailJobPath(id), doc);
    if (failure !== null) {
      // 宛先0件は帳票生成まで可、送信は FAILED_FINAL（業務要件 §5）
      appendAudit(tx, { action: 'MAIL_FAILED', targetType: 'MAIL_JOB', targetId: id, afterData: { errorCode: failure, documentJobId: input.documentJobId }, correlationId: input.documentJobId, occurredAt: now });
      enqueueEvent(tx, { type: 'MailFailed', aggregateType: 'Mail', aggregateId: id, correlationId: input.documentJobId, causationId: null, occurredAt: now, payload: { mailJobId: id, errorCode: failure } });
    }
  };
}

export interface MailDeps {
  readonly store: DocStore;
  readonly storage: StorageAdapter;
  readonly sender: MailSender;
  readonly now: () => Date;
}

type MailRow = MailJobDoc & { id: string };

class FinalFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function claim(store: DocStore, now: Date): Promise<MailRow | null> {
  const candidates = (await store.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'status', op: 'in', value: CLAIM_STATUSES('SENDING') }] }))
    .filter((r) => isClaimable(r.data, 'SENDING', now))
    .sort((a, b) => a.data.createdAt.getTime() - b.data.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  for (const c of candidates) {
    const claimed = await store.runTransaction(async (tx) => {
      const job = await tx.get<MailJobDoc>(mailJobPath(c.id));
      if (job === null || !isClaimable(job, 'SENDING', now)) return null;
      const attempts = job.attempts + 1;
      tx.update(mailJobPath(c.id), { status: 'SENDING', attempts, updatedAt: now });
      return { ...job, id: c.id, attempts };
    });
    if (claimed !== null) return claimed;
  }
  return null;
}

export async function processOneMailJob(deps: MailDeps): Promise<'none' | 'sent' | 'retry' | 'final'> {
  const job = await claim(deps.store, deps.now());
  if (job === null) return 'none';
  try {
    const d = await deps.store.get<DocumentJobDoc>(documentPath(job.documentJobId));
    const f = d?.fileId ? await deps.store.get<FileDoc>(`${C.files}/${d.fileId}`) : null;
    if (d === null || d.status !== 'GENERATED' || f === null) throw new FinalFailure('DOCUMENT_NOT_READY', '帳票が生成されていません');
    const check = normalizeRecipients([...job.recipients.to]);
    if (!check.ok) throw new FinalFailure(check.code, check.detail);
    if (hasHeaderInjection(job.subject)) throw new FinalFailure('RECIPIENT_INVALID', 'subject header injection');
    const stored = await deps.storage.get(f.storageKey);
    if (createHash('sha256').update(stored.bytes).digest('hex') !== f.sha256) throw new FinalFailure('HASH_MISMATCH', 'PDF hash 不一致');
    const attachments = [{ filename: job.recipients.attachmentName, contentType: 'application/pdf', bytes: stored.bytes }];
    if (attachments.length > MAIL_MAX_ATTACHMENTS || attachments.reduce((s, a) => s + a.bytes.byteLength, 0) > MAIL_MAX_TOTAL_BYTES) {
      throw new FinalFailure('FILE_TOO_LARGE', '添付が 20MB を超えています');
    }
    const messageId = messageIdOf(job.idempotencyKey);
    const providerId =
      (await deps.sender.findSent(messageId)) ??
      (await deps.sender.send({ messageId, to: check.recipients, cc: [...job.recipients.cc], bcc: [...job.recipients.bcc], subject: job.subject, text: job.recipients.text, attachments }));
    const now = deps.now();
    await deps.store.runTransaction(async (tx) => {
      tx.update(mailJobPath(job.id), { status: 'SENT', providerMessageId: providerId, errorCode: null, updatedAt: now });
      // audit に宛先・本文は残さない（SEC-017）。件数のみ
      appendAudit(tx, { action: 'MAIL_SENT', targetType: 'MAIL_JOB', targetId: job.id, afterData: { documentJobId: job.documentJobId, recipientCount: check.recipients.length, providerMessageId: providerId, attempts: job.attempts }, correlationId: job.documentJobId, occurredAt: now });
      enqueueEvent(tx, { type: 'MailSent', aggregateType: 'Mail', aggregateId: job.id, correlationId: job.documentJobId, causationId: null, occurredAt: now, payload: { mailJobId: job.id, providerMessageId: providerId } });
    });
    return 'sent';
  } catch (error) {
    const final = error instanceof FinalFailure;
    const adapter = error instanceof AdapterError || error instanceof StorageError;
    const code = final ? error.code : adapter ? (error as AdapterError | StorageError).code : 'DEPENDENCY_UNAVAILABLE';
    const retryable = !final && (!adapter || (error as AdapterError | StorageError).retryable);
    const outcome = decideRetry(job.attempts, retryable);
    const now = deps.now();
    await deps.store.runTransaction(async (tx) => {
      tx.update(mailJobPath(job.id), { status: outcome.status, errorCode: code, updatedAt: now });
      if (outcome.status === 'FAILED_FINAL') {
        appendAudit(tx, { action: 'MAIL_FAILED', targetType: 'MAIL_JOB', targetId: job.id, afterData: { documentJobId: job.documentJobId, errorCode: code, attempts: job.attempts }, correlationId: job.documentJobId, occurredAt: now });
        enqueueEvent(tx, { type: 'MailFailed', aggregateType: 'Mail', aggregateId: job.id, correlationId: job.documentJobId, causationId: null, occurredAt: now, payload: { mailJobId: job.id, errorCode: code } });
      }
    });
    return outcome.status === 'FAILED_FINAL' ? 'final' : 'retry';
  }
}
