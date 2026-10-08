/** 1回分の処理（dispatch → 帳票 → メール）。index.ts が一定間隔で呼ぶ。試験からも直接呼ぶ */
import { dispatchOutbox } from './dispatcher';
import { processOneDocumentJob, type DocumentDeps } from './document-jobs';
import { processOneMailJob, type MailDeps } from './mail-jobs';

export interface WorkerDeps extends DocumentDeps, MailDeps {}

export async function runOnce(deps: WorkerDeps, maxJobs = 10): Promise<{ dispatched: number; documents: string[]; mails: string[] }> {
  const dispatched = await dispatchOutbox(deps.pool, deps.now());
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
