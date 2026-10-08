import type { IdempotencyRecord } from '@inspexor/domain';

/** idempotency_records（actor+route+key 一意、24h） */
export interface StoredIdempotencyRecord extends IdempotencyRecord {
  readonly id: string;
}

export interface IdempotencyKeyScope {
  readonly actorId: string;
  readonly route: string;
  readonly key: string;
}

export interface IdempotencyRepository {
  find(scope: IdempotencyKeyScope): Promise<StoredIdempotencyRecord | null>;
  /** 新規PROCESSINGを作成。一意制約衝突（並行request）時は null */
  insertProcessing(scope: IdempotencyKeyScope, requestHash: string, expiresAt: Date): Promise<string | null>;
  /** 期限切れ/FAILEDの既存行を新しいhashでPROCESSINGに戻す */
  restartProcessing(id: string, requestHash: string, expiresAt: Date): Promise<void>;
  complete(id: string, responseStatus: number, responseBody: unknown): Promise<void>;
  fail(id: string): Promise<void>;
}
