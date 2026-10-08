import { JOB_RETRY_DELAYS_SECONDS } from '@inspexor/domain';

/** PROCESSING / SENDING の lease（期限内は他 worker が取得しない） */
export const JOB_LEASE_SECONDS = 300;

/**
 * 取得可能条件: QUEUED、retry 待ち時間を過ぎた FAILED_RETRYABLE、lease 切れの実行中。
 * $1 = now、$2 = 実行中状態（PROCESSING / SENDING）
 */
export const CLAIMABLE_SQL = `(
  status = 'QUEUED'
  OR (status = 'FAILED_RETRYABLE' AND updated_at <= $1::timestamptz - make_interval(secs => (ARRAY[${JOB_RETRY_DELAYS_SECONDS.join(',')}])[GREATEST(attempts, 1)]))
  OR (status = $2::app.job_status AND updated_at <= $1::timestamptz - make_interval(secs => ${JOB_LEASE_SECONDS}))
)`;
