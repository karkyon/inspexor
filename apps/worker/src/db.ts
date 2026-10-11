/**
 * worker の Firestore 書込部品（CHG-006）。worker の処理は SYSTEM（actorId null）。
 */
import { randomUUID } from 'node:crypto';
import { appendAudit as append, enqueueOutbox, type DocTransaction } from '@inspexor/docstore';
import type { OutboxEventType } from '@inspexor/application';

export function appendAudit(
  tx: DocTransaction,
  e: { action: string; targetType: string; targetId: string; beforeData?: unknown; afterData?: unknown; reason?: string | null; correlationId: string; occurredAt: Date },
): void {
  append(
    tx,
    {
      actorId: null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      ...(e.beforeData !== undefined ? { beforeData: e.beforeData } : {}),
      ...(e.afterData !== undefined ? { afterData: e.afterData } : {}),
      ...(e.reason !== undefined && e.reason !== null ? { reason: e.reason } : {}),
      correlationId: e.correlationId,
      occurredAt: e.occurredAt,
    },
    e.occurredAt,
  );
}

/** outbox（API設計書 §Event envelope） */
export function enqueueEvent(
  tx: DocTransaction,
  e: { type: OutboxEventType; aggregateType: string; aggregateId: string; correlationId: string; causationId: string | null; occurredAt: Date; payload: Record<string, unknown>; eventId?: string },
): string {
  const eventId = e.eventId ?? randomUUID();
  enqueueOutbox(
    tx,
    { eventId, type: e.type, version: 1, occurredAt: e.occurredAt.toISOString(), aggregateType: e.aggregateType, aggregateId: e.aggregateId, correlationId: e.correlationId, causationId: e.causationId, payload: e.payload },
    e.occurredAt,
  );
  return eventId;
}
