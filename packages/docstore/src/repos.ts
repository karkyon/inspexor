/**
 * 共通の書込部品（CHG-006 §3）。業務サービスの transaction の中で使う。
 *  - 監査（auditEvents、追記のみ: create しか持たない）
 *  - outbox（業務更新と同じ transaction で作る）
 *  - 一意キー（uniqueKeys: UNIQUE 制約の代わり）
 *  - 採番カウンタ（counters）
 *  - 冪等性（idempotency、TTL で期限切れを削除）
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, AuditRepository, IdempotencyKeyScope, IdempotencyRepository, OutboxEventEnvelope, OutboxRepository, StoredIdempotencyRecord } from '@inspexor/application';
import type { IdempotencyRecordStatus } from '@inspexor/domain';
import { DocStoreError, safeId, type DocReader, type DocStore, type DocTransaction } from './types';

export const C = {
  users: 'users',
  customers: 'customers',
  customerContacts: 'customerContacts',
  products: 'products',
  workTypes: 'workTypes',
  defectTypes: 'defectTypes',
  workers: 'workers',
  workLocations: 'workLocations',
  vehicles: 'vehicles',
  holidays: 'holidays',
  uniqueKeys: 'uniqueKeys',
  counters: 'counters',
  workReports: 'workReports',
  deliveryReports: 'deliveryReports',
  documents: 'documents',
  files: 'files',
  templateVersions: 'templateVersions',
  mailJobs: 'mailJobs',
  outbox: 'outbox',
  idempotency: 'idempotency',
  auditEvents: 'auditEvents',
} as const;

// ---------------- 監査 ----------------

export interface AuditDoc {
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** before/after は入れ子配列を避けるため JSON 文字列で保存する */
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

/** transaction 内で監査を1件追加し、ID を返す */
export function appendAudit(tx: DocTransaction, record: AuditRecord, now: Date): string {
  const id = randomUUID();
  const doc: AuditDoc = {
    actorId: record.actorId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    beforeJson: record.beforeData === undefined ? null : JSON.stringify(record.beforeData),
    afterJson: record.afterData === undefined ? null : JSON.stringify(record.afterData),
    reason: record.reason ?? null,
    correlationId: record.correlationId,
    occurredAt: record.occurredAt ?? now,
  };
  tx.create(`${C.auditEvents}/${id}`, doc);
  return id;
}

/** application の AuditRepository port（transaction 内） */
export class TxAuditRepository implements AuditRepository {
  constructor(
    private readonly tx: DocTransaction,
    private readonly now: Date,
  ) {}

  async append(record: AuditRecord): Promise<string> {
    return appendAudit(this.tx, record, this.now);
  }
}

/** transaction の外で1件だけ監査を書く（入口ガードの拒否記録など） */
export class StoreAuditRepository implements AuditRepository {
  constructor(
    private readonly store: DocStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async append(record: AuditRecord): Promise<string> {
    return this.store.runTransaction(async (tx) => appendAudit(tx, record, this.now()));
  }
}

/** 監査の読出し（試験・調査用）。before/after は復元して返す */
export async function auditEventsFor(db: DocReader, targetType: string, targetId: string): Promise<Array<AuditDoc & { id: string; beforeData: unknown; afterData: unknown }>> {
  const rows = await db.query<AuditDoc>(C.auditEvents, { where: [{ field: 'targetId', op: '==', value: targetId }] });
  return rows
    .filter((r) => r.data.targetType === targetType)
    .map((r) => ({
      ...r.data,
      id: r.id,
      beforeData: r.data.beforeJson === null ? null : (JSON.parse(r.data.beforeJson) as unknown),
      afterData: r.data.afterJson === null ? null : (JSON.parse(r.data.afterJson) as unknown),
    }))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
}

// ---------------- outbox ----------------

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'FAILED';

export interface OutboxDoc {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** envelope 全体（correlationId/causationId を含む）を JSON で保存 */
  readonly envelopeJson: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly createdAt: Date;
}

export function enqueueOutbox(tx: DocTransaction, event: OutboxEventEnvelope, now: Date): void {
  const doc: OutboxDoc = {
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    envelopeJson: JSON.stringify(event),
    status: 'PENDING',
    attempts: 0,
    availableAt: now,
    createdAt: now,
  };
  tx.create(`${C.outbox}/${event.eventId}`, doc);
}

export class TxOutboxRepository implements OutboxRepository {
  constructor(
    private readonly tx: DocTransaction,
    private readonly now: Date,
  ) {}

  async enqueue(event: OutboxEventEnvelope): Promise<void> {
    enqueueOutbox(this.tx, event, this.now);
  }
}

// ---------------- 一意キー ----------------

export interface UniqueKeyDoc {
  readonly kind: string;
  readonly scope: string;
  readonly value: string;
  readonly ownerId: string;
}

/** 一意キー文書のパス。scope は親 ID（全体で一意なら '-'） */
export function uniqueKeyPath(kind: string, scope: string, value: string): string {
  return `${C.uniqueKeys}/${safeId(`${kind}:${scope}:${value}`)}`;
}

/** transaction の読込段階で使う: 他の文書が使っていれば その ownerId */
export async function readUniqueOwner(tx: DocReader, kind: string, scope: string, value: string): Promise<string | null> {
  const doc = await tx.get<UniqueKeyDoc>(uniqueKeyPath(kind, scope, value));
  return doc?.ownerId ?? null;
}

/** transaction の書込段階で使う: 一意キーを確保（既存なら commit 時に ALREADY_EXISTS） */
export function claimUnique(tx: DocTransaction, kind: string, scope: string, value: string, ownerId: string): void {
  const doc: UniqueKeyDoc = { kind, scope, value, ownerId };
  tx.create(uniqueKeyPath(kind, scope, value), doc);
}

export function releaseUnique(tx: DocTransaction, kind: string, scope: string, value: string): void {
  tx.delete(uniqueKeyPath(kind, scope, value));
}

// ---------------- 採番 ----------------

export interface CounterDoc {
  readonly value: number;
}

export function counterPath(name: string): string {
  return `${C.counters}/${safeId(name)}`;
}

/** 読込段階: 現在値（無ければ 0） */
export async function readCounter(tx: DocReader, name: string): Promise<number> {
  return (await tx.get<CounterDoc>(counterPath(name)))?.value ?? 0;
}

/** 書込段階: 値を保存 */
export function writeCounter(tx: DocTransaction, name: string, value: number): void {
  const doc: CounterDoc = { value };
  tx.set(counterPath(name), doc);
}

// ---------------- 冪等性 ----------------

interface IdempotencyDoc {
  readonly actorId: string;
  readonly route: string;
  readonly key: string;
  readonly requestHash: string;
  readonly status: IdempotencyRecordStatus;
  /** TTL 対象（Firestore の TTL policy: idempotency.expiresAt） */
  readonly expiresAt: Date;
  readonly responseStatus: number | null;
  readonly responseJson: string | null;
  readonly createdAt: Date;
}

export function idempotencyId(scope: IdempotencyKeyScope): string {
  return createHash('sha256').update(JSON.stringify([scope.actorId, scope.route, scope.key])).digest('hex');
}

export class DocIdempotencyRepository implements IdempotencyRepository {
  constructor(
    private readonly store: DocStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(scope: IdempotencyKeyScope): Promise<StoredIdempotencyRecord | null> {
    const id = idempotencyId(scope);
    const d = await this.store.get<IdempotencyDoc>(`${C.idempotency}/${id}`);
    if (d === null) return null;
    return {
      id,
      requestHash: d.requestHash,
      status: d.status,
      expiresAt: d.expiresAt,
      ...(d.responseStatus !== null ? { responseStatus: d.responseStatus } : {}),
      ...(d.responseJson !== null ? { responseBody: JSON.parse(d.responseJson) as unknown } : {}),
    };
  }

  async insertProcessing(scope: IdempotencyKeyScope, requestHash: string, expiresAt: Date): Promise<string | null> {
    const id = idempotencyId(scope);
    const doc: IdempotencyDoc = {
      actorId: scope.actorId,
      route: scope.route,
      key: scope.key,
      requestHash,
      status: 'PROCESSING',
      expiresAt,
      responseStatus: null,
      responseJson: null,
      createdAt: this.now(),
    };
    try {
      await this.store.runTransaction(async (tx) => {
        tx.create(`${C.idempotency}/${id}`, doc);
      });
      return id;
    } catch (error) {
      if (error instanceof DocStoreError && error.code === 'ALREADY_EXISTS') return null;
      throw error;
    }
  }

  async restartProcessing(id: string, requestHash: string, expiresAt: Date): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      tx.update(`${C.idempotency}/${id}`, { requestHash, status: 'PROCESSING', expiresAt, responseStatus: null, responseJson: null });
    });
  }

  async complete(id: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      tx.update(`${C.idempotency}/${id}`, { status: 'COMPLETED', responseStatus, responseJson: JSON.stringify(responseBody ?? null) });
    });
  }

  async fail(id: string): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      tx.update(`${C.idempotency}/${id}`, { status: 'FAILED' });
    });
  }
}
