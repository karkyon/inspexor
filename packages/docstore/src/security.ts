/**
 * CHG-012 回数制限（SEC-009）の数え方。Cloud Run は複数の実行環境で動くため、ログインの回数は Firestore で数える。
 * 文書 `rateLimits/{sha256(bucket:key:区間開始)}` に回数を持ち、expiresAt（区間の終わり＋1時間）を過ぎたら TTL で消える。
 * key（接続元・ログインID）は sha256 にしてから保存する（個人を特定できる値を残さない）。
 */
import { createHash } from 'node:crypto';
import { decideRate, rateWindowStart, type RateDecision, type RateLimitRule } from '@inspexor/domain';
import { C } from './repos';
import type { DocStore } from './types';

export interface RateLimitDoc {
  readonly bucket: string;
  readonly count: number;
  readonly windowStart: Date;
  readonly expiresAt: Date;
}

export function rateLimitDocId(bucket: string, key: string, windowStartMs: number): string {
  return createHash('sha256').update(`${bucket}\u0000${key}\u0000${windowStartMs}`).digest('hex');
}

/** 1回分を数えて、許すかどうかを返す */
export async function consumeRateLimit(store: DocStore, bucket: string, key: string, rule: RateLimitRule, now: Date): Promise<RateDecision> {
  const nowMs = now.getTime();
  const start = rateWindowStart(nowMs, rule.windowMs);
  const path = `${C.rateLimits}/${rateLimitDocId(bucket, key, start)}`;
  const count = await store.runTransaction(async (tx) => {
    const cur = await tx.get<RateLimitDoc>(path);
    const next = (cur?.count ?? 0) + 1;
    const doc: RateLimitDoc = { bucket, count: next, windowStart: new Date(start), expiresAt: new Date(start + rule.windowMs + 3_600_000) };
    tx.set(path, doc);
    return next;
  });
  return decideRate(count, rule, nowMs);
}
