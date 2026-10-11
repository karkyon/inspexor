/** 1回分の処理（dispatch → 帳票 → メール）。index.ts（常駐 or HTTP 起動）が呼ぶ。試験からも直接呼ぶ */
import { dispatchOutbox } from './dispatcher';
import { processOneDocumentJob, type DocumentDeps } from './document-jobs';
import { processOneMailJob, type MailDeps } from './mail-jobs';

export interface WorkerDeps extends DocumentDeps, MailDeps {}

export async function runOnce(deps: WorkerDeps, maxJobs = 10): Promise<{ dispatched: number; documents: string[]; mails: string[] }> {
  const started = Date.now();
  const dispatched = await dispatchOutbox(deps.store, deps.now());
  const ms = Date.now() - started;
  // 配送が遅いときだけ記録（遅い工程の特定用。試験では出さない）
  if (ms >= 2000 && process.env['WORKER_TIMING'] !== '0' && process.env['VITEST'] === undefined) console.log(`[worker] dispatch events=${dispatched} ms=${ms}`);
  const documents: string[] = [];
  for (let i = 0; i < maxJobs; i += 1) {
    const r = await processOneDocumentJob(deps);
    if (r === 'none') break;
    documents.push(r);
  }
  const mails: string[] = [];
  for (let i = 0; i < maxJobs; i += 1) {
    const r = await processOneMailJob(deps);
    if (r === 'none') break;
    mails.push(r);
  }
  return { dispatched, documents, mails };
}

/**
 * 仕事が無くなるまで runOnce を繰り返す（HTTP 起動用）。時間上限の手前で止め、残りは次の起動で処理する。
 * dispatch した event から作った job を同じ起動で処理するため、何も進まなくなるまで回す。
 */
export async function drain(deps: WorkerDeps, budgetMs: number): Promise<{ rounds: number; dispatched: number; documents: number; mails: number }> {
  const started = Date.now();
  const total = { rounds: 0, dispatched: 0, documents: 0, mails: 0 };
  while (Date.now() - started < budgetMs) {
    const r = await runOnce(deps);
    total.rounds += 1;
    total.dispatched += r.dispatched;
    total.documents += r.documents.length;
    total.mails += r.mails.length;
    if (r.dispatched + r.documents.length + r.mails.length === 0) break;
  }
  return total;
}
