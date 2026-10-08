/**
 * transactional outbox（00契約 不変条件4 / SEC-029）。業務更新と同一transactionで enqueue する。
 * envelope は API設計書 §Event:
 *   eventId,type,version,occurredAt,aggregateType,aggregateId,correlationId,causationId,payload
 */
export const OUTBOX_EVENT_TYPES = [
  'WorkReportConfirmed',
  'DeliveryReportConfirmed',
  'DocumentRequested',
  'DocumentGenerated',
  'DocumentFailed',
  'RecordSubmitted',
  'RecordApproved',
  'RecordRejected',
  'RecordRevoked',
  'BillingRequested',
  'BillingCalculated',
  'BillingFinalized',
  'InvoiceIssued',
  'MailRequested',
  'MailSent',
  'MailFailed',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEventEnvelope {
  readonly eventId: string;
  readonly type: OutboxEventType;
  readonly version: number;
  readonly occurredAt: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxRepository {
  enqueue(event: OutboxEventEnvelope): Promise<void>;
}

/** API設計書: retry 10s/30s/2m/10m/30m（network/408/429/5xxのみ） */
export const OUTBOX_RETRY_DELAYS_SECONDS: readonly number[] = [10, 30, 120, 600, 1800];
