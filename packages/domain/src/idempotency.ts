/**
 * 00_INSPEXOR_仕様正本_Claude実装契約_v5.1.md 不変条件3および
 * schema.sql idempotency_records（actor_id+route+idempotency_key一意、
 * request_hash char(64)、status IN (PROCESSING,COMPLETED,FAILED)、expires_at）準拠。
 *
 * GAP: status=FAILEDの場合の再実行可否は00契約に明記がない。
 * 本実装は「同key・同hashであれば再実行を許可する(PROCEED)」という解釈(derived)を採る。
 * 未決事項・変更管理台帳へのGAP登録を推奨する。
 */

export type IdempotencyRecordStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly status: IdempotencyRecordStatus;
  readonly expiresAt: Date;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
}

export type IdempotencyDecision =
  | { readonly action: 'PROCEED' }
  | { readonly action: 'REPLAY'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly action: 'IN_PROGRESS' }
  | { readonly action: 'CONFLICT' };

export function decideIdempotency(
  existing: IdempotencyRecord | null,
  requestHash: string,
  now: Date,
): IdempotencyDecision {
  if (!existing) {
    return { action: 'PROCEED' };
  }

  if (existing.expiresAt.getTime() <= now.getTime()) {
    // 24時間window超過。00契約§3.3の対象外であり新規requestとして扱う。
    return { action: 'PROCEED' };
  }

  if (existing.requestHash !== requestHash) {
    // 同一key・異hash → 409 IDEMPOTENCY_CONFLICT（不変条件3）
    return { action: 'CONFLICT' };
  }

  if (existing.status === 'COMPLETED') {
    return { action: 'REPLAY', responseStatus: existing.responseStatus ?? 200, responseBody: existing.responseBody };
  }

  if (existing.status === 'PROCESSING') {
    return { action: 'IN_PROGRESS' };
  }

  // FAILED: derived（仕様未記載、GAP）
  return { action: 'PROCEED' };
}

export const IDEMPOTENCY_REQUEST_HASH_LENGTH = 64; // schema.sql: request_hash char(64) (SHA-256 hex)
export const IDEMPOTENCY_WINDOW_HOURS = 24; // 00契約 不変条件3
