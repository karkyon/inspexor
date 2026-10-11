/**
 * 帳票 job（FR-005 / REQ-DOC-001 / CHG-003）。CHG-006: Firestore 版。
 *   revision snapshot → template（version 固定・registry の sha256 照合）→ placeholder 置換 → 未置換検査
 *   → PDF（Chromium）→ 20MB 検査 → storage → 読み戻し hash 照合 → files / GENERATED（＋CONFIRMED→SUBMITTED）
 *   → 日報は mail job（宛先 snapshot。CHG-004 により dailyMailEnabled=true のときだけ）。失敗は retry（network/5xx 相当）か FAILED_FINAL。record は失敗でも保持。
 * 報告ヘッダの帳票状態（documentStatus）は、その job が最新の帳票（header.documentId）のときだけ更新する。
 */
import { createHash, randomUUID } from 'node:crypto';
import { decideRetry, documentFileName, findUnresolvedPlaceholders, MAIL_MAX_TOTAL_BYTES, renderTemplate, type TemplateType } from '@inspexor/domain';
import {
  C,
  documentPath,
  filePath,
  md5Base64,
  reportPath,
  StorageError,
  type DocStore,
  type DocTransaction,
  type DocumentJobDoc,
  type FileDoc,
  type JobStatus,
  type ReportHeaderDoc,
  type StorageAdapter,
} from '@inspexor/docstore';
import { appendAudit, enqueueEvent } from './db';
import { CLAIM_STATUSES, isClaimable } from './jobs-common';
import { prepareDailyMailJob } from './mail-jobs';
import { AdapterError, type PdfRenderer } from './ports';
import { deliverySnapshot, ensureRegistered, loadFixtureTemplate, workSnapshot, type DocumentSnapshot } from './templates';

export interface DocumentDeps {
  readonly store: DocStore;
  readonly storage: StorageAdapter;
  readonly pdf: PdfRenderer;
  readonly now: () => Date;
  readonly templateDir?: string;
  /** CHG-004: 日報メールの自動送信（既定 false = 送らない） */
  readonly dailyMailEnabled?: boolean;
}

type JobRow = DocumentJobDoc & { id: string };

class FinalFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const TARGET: Record<string, { aggregate: string; target: string }> = {
  WORK_REVISION: { aggregate: 'Work', target: 'WORK_REPORT' },
  DELIVERY_REVISION: { aggregate: 'Delivery', target: 'DELIVERY_REPORT' },
};

/** 読込段階: ヘッダ。書込段階で帳票状態を反映する関数を返す */
async function headerStatusUpdater(tx: DocTransaction, job: JobRow): Promise<{ header: ReportHeaderDoc | null; apply: (status: JobStatus, extra?: Record<string, unknown>) => void }> {
  const header = await tx.get<ReportHeaderDoc>(reportPath(job.reportType, job.reportId));
  return {
    header,
    apply: (status, extra = {}) => {
      if (header === null) return;
      const own = header.documentId === job.id;
      if (own || Object.keys(extra).length > 0) {
        tx.update(reportPath(job.reportType, job.reportId), { ...(own ? { documentStatus: status } : {}), ...extra });
      }
    },
  };
}

async function claim(store: DocStore, now: Date): Promise<JobRow | null> {
  const candidates = (await store.query<DocumentJobDoc>(C.documents, { where: [{ field: 'status', op: 'in', value: CLAIM_STATUSES('PROCESSING') }] }))
    .filter((r) => isClaimable(r.data, 'PROCESSING', now))
    .sort((a, b) => a.data.createdAt.getTime() - b.data.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  for (const c of candidates) {
    const claimed = await store.runTransaction(async (tx) => {
      const job = await tx.get<DocumentJobDoc>(documentPath(c.id));
      if (job === null || !isClaimable(job, 'PROCESSING', now)) return null;
      const row: JobRow = { ...job, id: c.id, attempts: job.attempts + 1 };
      const h = await headerStatusUpdater(tx, row);
      tx.update(documentPath(c.id), { status: 'PROCESSING', attempts: row.attempts, updatedAt: now });
      h.apply('PROCESSING');
      return row;
    });
    if (claimed !== null) return claimed;
  }
  return null;
}

/**
 * 処理時間の記録（工程ごと）。遅い工程を worker のログで特定できるようにする（CHG-006 g24b）。
 * 出力: [worker] job <id 先頭8桁> <template> <結果> claim=… snapshot=… template=… render=… put=… verify=… commit=… total=…（ms）
 */
class StepTimer {
  private readonly started = Date.now();
  private last = this.started;
  private readonly steps: Array<[string, number]> = [];

  lap(name: string): void {
    const now = Date.now();
    this.steps.push([name, now - this.last]);
    this.last = now;
  }

  line(job: JobRow, outcome: string): string {
    const parts = this.steps.map(([k, v]) => `${k}=${v}`).join(' ');
    return `[worker] job ${job.id.slice(0, 8)} ${job.templateVersion} ${outcome} ${parts} total=${Date.now() - this.started}`;
  }
}

/** 試験では出さない（WORKER_TIMING=0 で抑止。既定は出す） */
function logTiming(line: string): void {
  if (process.env['WORKER_TIMING'] !== '0' && process.env['VITEST'] === undefined) console.log(line);
}

export async function processOneDocumentJob(deps: DocumentDeps): Promise<'none' | 'generated' | 'retry' | 'final'> {
  const timer = new StepTimer();
  const job = await claim(deps.store, deps.now());
  if (job === null) return 'none';
  timer.lap('claim');
  const template = job.templateVersion as TemplateType;
  try {
    const src = { reportId: job.reportId, revisionId: job.revisionId };
    const snapshot: DocumentSnapshot | null =
      job.sourceType === 'WORK_REVISION'
        ? await workSnapshot(deps.store, src, template === 'DAILY_REPORT_V1' ? 'DAILY_REPORT_V1' : 'DAILY_REPORT_V2')
        : await deliverySnapshot(deps.store, src);
    if (snapshot === null || snapshot.type !== template) throw new FinalFailure('SOURCE_NOT_FOUND', '確定済み revision が見つかりません');
    timer.lap('snapshot');
    let loaded;
    try {
      loaded = loadFixtureTemplate(template, deps.templateDir);
    } catch (error) {
      throw new FinalFailure('TEMPLATE_INVALID', String(error));
    }
    if ((await ensureRegistered(deps.store, loaded, deps.now())) !== 'ok') throw new FinalFailure('TEMPLATE_INVALID', 'template の sha256 が registry と一致しません');
    const html = renderTemplate(loaded.html, snapshot.values);
    const unresolved = findUnresolvedPlaceholders(html);
    if (unresolved.length > 0) throw new FinalFailure('TEMPLATE_INVALID', `未置換 placeholder: ${unresolved.join(', ')}`);
    timer.lap('template');
    const pdf = await deps.pdf.render(html);
    timer.lap('render');
    if (pdf.byteLength > MAIL_MAX_TOTAL_BYTES) throw new FinalFailure('FILE_TOO_LARGE', `PDF が上限を超えています（${pdf.byteLength} bytes）`);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const fileName = documentFileName(template, snapshot.fileName);
    const storageKey = `documents/${job.documentType}/${snapshot.reportNo}/${job.id}/${fileName}`;
    await deps.storage.put(storageKey, pdf, 'application/pdf');
    timer.lap('put');
    // 保存内容の照合（g25a）: 本文を読み戻さず、保存先が計算したサイズと MD5 を照合する。MD5 が無い保存先だけ読み戻して sha256 を照合する
    const stored = await deps.storage.stat(storageKey);
    const same =
      stored.md5Base64 !== null
        ? stored.sizeBytes === pdf.byteLength && stored.md5Base64 === md5Base64(pdf)
        : createHash('sha256').update((await deps.storage.get(storageKey)).bytes).digest('hex') === sha256;
    timer.lap('verify');
    if (!same) throw new FinalFailure('HASH_MISMATCH', '保存した PDF の hash が一致しません');

    const now = deps.now();
    const fileId = randomUUID();
    await deps.store.runTransaction(async (tx) => {
      // ---- 読込
      const current = await tx.get<DocumentJobDoc>(documentPath(job.id));
      if (current === null || current.status !== 'PROCESSING' || current.attempts !== job.attempts) return; // 他の worker が取得し直した
      const h = await headerStatusUpdater(tx, job);
      const t = TARGET[job.sourceType];
      // RECORD_TRANSITIONS: CONFIRMED --documentGenerated(SYSTEM, PDF hash 有)--> SUBMITTED。current revision の帳票のみ
      const submit = t !== undefined && h.header !== null && h.header.status === 'CONFIRMED' && h.header.currentRevisionId === job.revisionId;
      const submitVersion = submit && h.header !== null ? h.header.version + 1 : null;
      // 日報メールは自動生成分のみ（手動再生成は送らない。送る場合は documentAction send）
      const mail =
        deps.dailyMailEnabled === true && snapshot.mail !== null && job.idempotencyKey.endsWith(':auto')
          ? await prepareDailyMailJob(tx, { documentJobId: job.id, snapshot, fileName, sendRevision: 1, reason: null }, now)
          : null;
      // ---- 書込
      const file: FileDoc = { storageKey, mimeType: 'application/pdf', sizeBytes: pdf.byteLength, sha256, classification: 'CONFIDENTIAL', createdAt: now };
      tx.create(filePath(fileId), file);
      tx.update(documentPath(job.id), { status: 'GENERATED', fileId, errorCode: null, updatedAt: now });
      h.apply('GENERATED', submitVersion !== null ? { status: 'SUBMITTED', version: submitVersion, updatedAt: now } : {});
      appendAudit(tx, {
        action: 'DOCUMENT_GENERATED',
        targetType: 'DOCUMENT_JOB',
        targetId: job.id,
        afterData: { template, revisionId: job.revisionId, fileId, sha256, sizeBytes: pdf.byteLength, attempts: job.attempts },
        correlationId: job.id,
        occurredAt: now,
      });
      enqueueEvent(tx, {
        type: 'DocumentGenerated',
        aggregateType: 'Document',
        aggregateId: job.id,
        correlationId: job.id,
        causationId: null,
        occurredAt: now,
        payload: { documentJobId: job.id, fileId, sha256, reportId: job.reportId, revisionId: job.revisionId },
      });
      if (submitVersion !== null && t !== undefined) {
        appendAudit(tx, {
          action: 'RECORD_SUBMIT',
          targetType: t.target,
          targetId: job.reportId,
          beforeData: { status: 'CONFIRMED' },
          afterData: { status: 'SUBMITTED', version: submitVersion, documentJobId: job.id },
          correlationId: job.id,
          occurredAt: now,
        });
        enqueueEvent(tx, {
          type: 'RecordSubmitted',
          aggregateType: t.aggregate,
          aggregateId: job.reportId,
          correlationId: job.id,
          causationId: null,
          occurredAt: now,
          payload: { reportId: job.reportId, revisionId: job.revisionId, version: submitVersion, documentJobId: job.id },
        });
      }
      if (mail !== null) mail();
    });
    timer.lap('commit');
    logTiming(timer.line(job, 'generated'));
    return 'generated';
  } catch (error) {
    const final = error instanceof FinalFailure;
    const adapter = error instanceof AdapterError || error instanceof StorageError;
    const retryable = adapter && (error as AdapterError | StorageError).retryable;
    const code = final ? error.code : adapter ? (error as AdapterError | StorageError).code : 'DEPENDENCY_UNAVAILABLE';
    const outcome = decideRetry(job.attempts, !final && (retryable || !adapter));
    const now = deps.now();
    await deps.store.runTransaction(async (tx) => {
      const h = await headerStatusUpdater(tx, job);
      tx.update(documentPath(job.id), { status: outcome.status, errorCode: code, updatedAt: now });
      h.apply(outcome.status);
      if (outcome.status === 'FAILED_FINAL') {
        appendAudit(tx, {
          action: 'DOCUMENT_FAILED',
          targetType: 'DOCUMENT_JOB',
          targetId: job.id,
          afterData: { template, revisionId: job.revisionId, errorCode: code, attempts: job.attempts },
          correlationId: job.id,
          occurredAt: now,
        });
        enqueueEvent(tx, {
          type: 'DocumentFailed',
          aggregateType: 'Document',
          aggregateId: job.id,
          correlationId: job.id,
          causationId: null,
          occurredAt: now,
          payload: { documentJobId: job.id, errorCode: code, revisionId: job.revisionId },
        });
      }
    });
    timer.lap('fail');
    logTiming(`${timer.line(job, outcome.status)} error=${code}`);
    return outcome.status === 'FAILED_FINAL' ? 'final' : 'retry';
  }
}
