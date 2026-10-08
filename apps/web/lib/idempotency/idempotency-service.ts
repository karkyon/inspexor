import { createHash } from 'node:crypto';
import { decideIdempotency, IDEMPOTENCY_WINDOW_HOURS } from '@inspexor/domain';
import type { IdempotencyKeyScope, IdempotencyRepository } from '@inspexor/application';

/** キー順を正規化したJSON（同一payloadなら同一hash） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** request SHA-256（API設計書: method+route+body を対象） */
export function computeRequestHash(method: string, route: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${route}\n${canonicalJson(body)}`).digest('hex');
}

export type IdempotencyBegin =
  | { readonly kind: 'PROCEED'; readonly recordId: string }
  | { readonly kind: 'REPLAY'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly kind: 'IN_PROGRESS' }
  | { readonly kind: 'CONFLICT' };

/**
 * 00契約 不変条件3: 同一key・同一hashは同応答（REPLAY）、異hashは409（CONFLICT）。
 * 処理中は IN_PROGRESS（呼出側は409 IDEMPOTENCY_CONFLICT retryable=true で返す）。
 */
export async function beginIdempotentRequest(
  repo: IdempotencyRepository,
  scope: IdempotencyKeyScope,
  requestHash: string,
  now: Date,
): Promise<IdempotencyBegin> {
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_WINDOW_HOURS * 60 * 60_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await repo.find(scope);
    const decision = decideIdempotency(existing, requestHash, now);
    if (decision.action === 'REPLAY') {
      return { kind: 'REPLAY', responseStatus: decision.responseStatus, responseBody: decision.responseBody };
    }
    if (decision.action === 'IN_PROGRESS') {
      return { kind: 'IN_PROGRESS' };
    }
    if (decision.action === 'CONFLICT') {
      return { kind: 'CONFLICT' };
    }
    if (existing !== null) {
      await repo.restartProcessing(existing.id, requestHash, expiresAt);
      return { kind: 'PROCEED', recordId: existing.id };
    }
    const insertedId = await repo.insertProcessing(scope, requestHash, expiresAt);
    if (insertedId !== null) {
      return { kind: 'PROCEED', recordId: insertedId };
    }
    // 並行requestが先にinsertした: 再読込して判定し直す
  }
  return { kind: 'IN_PROGRESS' };
}
