import type { OutboxEventEnvelope, OutboxRepository } from '@inspexor/application';
import type { Queryable } from './pg';

/**
 * GAP-012: DB設計書 #31 outbox_events の主要列に "correlation" があるが schema.sql に列が無い。
 * schema.sql（DDL正本）を優先し、envelope全体（correlationId/causationId/version/occurredAt含む）を payload jsonb に保存する。
 */
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(event: OutboxEventEnvelope): Promise<void> {
    await this.db.query(
      `INSERT INTO app.outbox_events (id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [event.eventId, event.type, event.aggregateType, event.aggregateId, JSON.stringify(event)],
    );
  }
}
