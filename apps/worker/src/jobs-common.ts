import { JOB_RETRY_DELAYS_SECONDS } from '@inspexor/domain';

/** PROCESSING / SENDING の lease（期限内は他 worker が取得しない） */
export const JOB_LEASE_SECONDS = 300;

/**
 * 取得可能条件（PostgreSQL 版の CLAIMABLE_SQL と同じ）: QUEUED、retry 待ち時間を過ぎた FAILED_RETRYABLE、lease 切れの実行中。
 * retry 待ち時間は attempts 回目（1始まり）の値。表の範囲外（上限超過）は取得しない。
 */
export function isClaimable(job: { status: string; attempts: number; updatedAt: Date }, running: 'PROCESSING' | 'SENDING', now: Date): boolean {
  if (job.status === 'QUEUED') return true;
  if (job.status === 'FAILED_RETRYABLE') {
    const delay = JOB_RETRY_DELAYS_SECONDS[Math.max(job.attempts, 1) - 1];
    return delay !== undefined && job.updatedAt.getTime() <= now.getTime() - delay * 1000;
  }
  if (job.status === running) return job.updatedAt.getTime() <= now.getTime() - JOB_LEASE_SECONDS * 1000;
  return false;
}

/** 取得候補の状態（検索は status の in のみ＝単一項目の索引） */
export const CLAIM_STATUSES = (running: 'PROCESSING' | 'SENDING'): string[] => ['QUEUED', 'FAILED_RETRYABLE', running];
