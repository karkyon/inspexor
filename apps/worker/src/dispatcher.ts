/**
 * outbox dispatcher（機能別詳細設計書 §job）: PENDING の event ごとに1 transaction で consumer の job を作り DISPATCHED にする。
 * CHG-006: Firestore 版。event の状態を transaction 内で再確認するため、複数の worker が同時に動いても二重処理しない。
 * job の ID は冪等 key から決めるので、同じ event を二度処理しても job は1件（at-least-once 前提）。
 */
import {
  C,
  documentPath,
  reportPath,
  uuidFromKey,
  type DocStore,
  type DocTransaction,
  type DocumentJobDoc,
  type FileDoc,
  type OutboxDoc,
  type ReportHeaderDoc,
  type ReportType,
} from '@inspexor/docstore';
import type { OutboxEventEnvelope } from '@inspexor/application';
import { prepareDailyMailJob } from './mail-jobs';
import { workSnapshot } from './templates';

export const DOCUMENT_EVENT_TEMPLATE: Readonly<Record<string, { template: string; documentType: string; sourceType: 'WORK_REVISION' | 'DELIVERY_REVISION'; reportType: ReportType }>> = {
  // CHG-005: 新しく確定する作業日報は現行の作業結果報告書様式（V2）
  WorkReportConfirmed: { template: 'DAILY_REPORT_V2', documentType: 'DAILY_REPORT', sourceType: 'WORK_REVISION', reportType: 'WORK' },
  // CHG-010: 新しく確定する運搬実績は V2（使用車両・運搬回数。運搬費は載せない）
  DeliveryReportConfirmed: { template: 'DELIVERY_REPORT_V2', documentType: 'DELIVERY_REPORT', sourceType: 'DELIVERY_REVISION', reportType: 'DELIVERY' },
};

export function autoDocumentKey(template: string, revisionId: string): string {
  return `DOC:${template}:${revisionId}:auto`;
}

interface NewJob {
  readonly key: string;
  readonly documentType: string;
  readonly sourceType: 'WORK_REVISION' | 'DELIVERY_REVISION';
  readonly reportType: ReportType;
  readonly reportId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly template: string;
}

/**
 * 帳票 job の作成（読込段階で呼び、書込関数を返す）。既にあれば何もしない。
 * 最新の版の帳票なら、報告ヘッダの帳票状態（一覧・詳細の documentStatus）も更新する。
 */
async function prepareDocumentJob(tx: DocTransaction, job: NewJob, now: Date): Promise<(() => void) | null> {
  const id = uuidFromKey(job.key);
  if ((await tx.get(documentPath(id))) !== null) return null;
  const header = await tx.get<ReportHeaderDoc>(reportPath(job.reportType, job.reportId));
  return () => {
    const doc: DocumentJobDoc = {
      documentType: job.documentType,
      sourceType: job.sourceType,
      reportType: job.reportType,
      reportId: job.reportId,
      revisionId: job.revisionId,
      revisionNo: job.revisionNo,
      templateVersion: job.template,
      status: 'QUEUED',
      idempotencyKey: job.key,
      fileId: null,
      attempts: 0,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(documentPath(id), doc);
    if (header !== null && header.latestRevisionId === job.revisionId) {
      tx.update(reportPath(job.reportType, job.reportId), { documentId: id, documentStatus: 'QUEUED' });
    }
  };
}

/** 1件の event を処理（PENDING のときだけ）。処理したら true */
async function dispatchOne(store: DocStore, eventId: string, now: Date): Promise<boolean> {
  return store.runTransaction(async (tx) => {
    const ev = await tx.get<OutboxDoc>(`${C.outbox}/${eventId}`);
    if (ev === null || ev.status !== 'PENDING') return false;
    const envelope = JSON.parse(ev.envelopeJson) as OutboxEventEnvelope;
    const p = envelope.payload as Record<string, unknown>;
    const writes: Array<() => void> = [];
    const route = DOCUMENT_EVENT_TEMPLATE[ev.type];
    if (route !== undefined && typeof p['revisionId'] === 'string' && typeof p['reportId'] === 'string') {
      const w = await prepareDocumentJob(
        tx,
        {
          key: autoDocumentKey(route.template, p['revisionId']),
          documentType: route.documentType,
          sourceType: route.sourceType,
          reportType: route.reportType,
          reportId: p['reportId'],
          revisionId: p['revisionId'],
          revisionNo: Number(p['revisionNo'] ?? 1),
          template: route.template,
        },
        now,
      );
      if (w !== null) writes.push(w);
    }
    if (ev.type === 'DocumentRequested') {
      const w = await onDocumentRequested(tx, eventId, p, now);
      if (w !== null) writes.push(w);
    }
    if (ev.type === 'MailRequested') {
      const w = await onMailRequested(tx, eventId, p, now);
      if (w !== null) writes.push(w);
    }
    // consumer の無い event（RecordSubmitted 等）は配送済みとして扱う
    for (const w of writes) w();
    tx.update(`${C.outbox}/${eventId}`, { status: 'DISPATCHED', attempts: ev.attempts + 1 });
    return true;
  });
}

/** 配送待ちの event を古い順に処理する（availableAt を過ぎたもの） */
export async function dispatchOutbox(store: DocStore, now: Date, limit = 20): Promise<number> {
  const pending = await store.query<OutboxDoc>(C.outbox, { where: [{ field: 'status', op: '==', value: 'PENDING' }] });
  const ready = pending
    .filter((e) => e.data.availableAt.getTime() <= now.getTime())
    .sort((a, b) => a.data.createdAt.getTime() - b.data.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
  let n = 0;
  for (const e of ready) {
    if (await dispatchOne(store, e.id, now)) n += 1;
  }
  return n;
}

/** API-025 regenerate / retry（帳票）: 同じ確定 revision に新しい帳票 job（旧版は保持）。key は event 単位で冪等 */
async function onDocumentRequested(tx: DocTransaction, eventId: string, p: Record<string, unknown>, now: Date): Promise<(() => void) | null> {
  if (typeof p['documentJobId'] !== 'string' || typeof p['template'] !== 'string') return null;
  const original = await tx.get<DocumentJobDoc>(documentPath(p['documentJobId']));
  if (original === null) return null;
  return prepareDocumentJob(
    tx,
    {
      key: `DOC:${p['template']}:${original.revisionId}:${String(p['mode'])}:${eventId}`,
      documentType: original.documentType,
      sourceType: original.sourceType,
      reportType: original.reportType,
      reportId: original.reportId,
      revisionId: original.revisionId,
      revisionNo: original.revisionNo,
      template: p['template'],
    },
    now,
  );
}

/** API-025 send / retry（メール、既定で無効）: 生成済み日報を新しい mail job で送る（sendRevision+1、宛先は現時点の snapshot） */
async function onMailRequested(tx: DocTransaction, eventId: string, p: Record<string, unknown>, now: Date): Promise<(() => void) | null> {
  if (typeof p['documentJobId'] !== 'string') return null;
  const documentJobId = p['documentJobId'];
  const d = await tx.get<DocumentJobDoc>(documentPath(documentJobId));
  if (d === null || d.status !== 'GENERATED' || d.sourceType !== 'WORK_REVISION' || d.fileId === null) return null;
  const file = await tx.get<FileDoc>(`${C.files}/${d.fileId}`);
  if (file === null) return null;
  const snapshot = await workSnapshot(tx, { reportId: d.reportId, revisionId: d.revisionId });
  if (snapshot === null) return null;
  const existing = await tx.query<{ sendRevision: number }>(C.mailJobs, { where: [{ field: 'documentJobId', op: '==', value: documentJobId }] });
  const sendRevision = existing.reduce((m, r) => Math.max(m, r.data.sendRevision), 0) + 1;
  return prepareDailyMailJob(
    tx,
    {
      documentJobId,
      snapshot,
      fileName: file.storageKey.split('/').pop() as string,
      sendRevision,
      reason: null,
      idempotencyKey: `MAIL:DAILY_REPORT:${documentJobId}:req:${eventId}`,
    },
    now,
  );
}
