/**
 * CHG-012 回数制限（SEC-009 / GAP-010）。超えたら 429 RATE_LIMITED と Retry-After（秒）を返す。
 *   ログイン（ログイン・確認コード・再認証）: Firestore で数える（複数の実行環境で共有）。接続元と、ログインID（または利用者）の2つ
 *   更新・参照（API 全般）: 実行環境ごとにメモリで数える（利用者ごと。Firestore の読み書きを増やさない）
 */
import { decideRate, RATE_LIMITS, rateWindowStart, type RateDecision, type RateLimitBucket, type RateLimitRule } from '@inspexor/domain';
import { consumeRateLimit, type DocStore } from '@inspexor/docstore';
import { errorResponse } from '../http/api-response';

/**
 * 接続元。Cloud Run は X-Forwarded-For の末尾に実際の接続元を付け足すため、末尾を使う（先頭は利用者が自由に書ける）。
 * ヘッダが無い（開発のローカル接続）ときは 'local'
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff !== null) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const last = parts[parts.length - 1];
    if (last !== undefined) return last.slice(0, 64);
  }
  return 'local';
}

/** ログイン系の回数制限（接続元＋ログインID）。どちらかが上限を超えたら拒否 */
export type LoginRateLimit = (request: Request, subject: string, now: Date) => Promise<RateDecision>;

export function createLoginRateLimit(store: () => DocStore, rules: { ip: RateLimitRule; id: RateLimitRule } = { ip: RATE_LIMITS.loginIp, id: RATE_LIMITS.loginId }): LoginRateLimit {
  return async (request, subject, now) => {
    const ip = await consumeRateLimit(store(), 'loginIp', clientIp(request), rules.ip, now);
    if (!ip.ok) return ip;
    return consumeRateLimit(store(), 'loginId', subject.trim().toLowerCase(), rules.id, now);
  };
}

/** API 全般（利用者ごと、実行環境内）。古い区間は数え直すときに捨てる */
export class MemoryRateLimiter {
  private readonly counts = new Map<string, { start: number; count: number }>();

  constructor(private readonly rules: Readonly<Record<'command' | 'read', RateLimitRule>> = { command: RATE_LIMITS.command, read: RATE_LIMITS.read }) {}

  consume(bucket: 'command' | 'read', key: string, nowMs: number): RateDecision {
    const rule = this.rules[bucket];
    const start = rateWindowStart(nowMs, rule.windowMs);
    const k = `${bucket}:${key}`;
    const cur = this.counts.get(k);
    const count = cur !== undefined && cur.start === start ? cur.count + 1 : 1;
    this.counts.set(k, { start, count });
    if (this.counts.size > 10_000) {
      for (const [key2, v] of this.counts) if (v.start !== start) this.counts.delete(key2);
    }
    return decideRate(count, rule, nowMs);
  }
}

export function rateLimitedResponse(retryAfterSeconds: number, correlationId: string): Response {
  const res = errorResponse(429, 'RATE_LIMITED', 'しばらく時間をおいてから再度お試しください。', correlationId, { retryable: true, extra: { retryAfterSeconds } });
  res.headers.set('Retry-After', String(retryAfterSeconds));
  return res;
}

export type { RateLimitBucket };
