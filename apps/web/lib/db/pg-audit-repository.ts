import type { AuditRecord, AuditRepository } from '@inspexor/application';
import type { Queryable } from './pg';

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: Queryable) {}

  async append(record: AuditRecord): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO app.audit_events
         (actor_id, action, target_type, target_id, before_data, after_data, reason, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, COALESCE($9::timestamptz, now()))
       RETURNING id`,
      [
        record.actorId,
        record.action,
        record.targetType,
        record.targetId,
        record.beforeData === undefined ? null : JSON.stringify(record.beforeData),
        record.afterData === undefined ? null : JSON.stringify(record.afterData),
        record.reason ?? null,
        record.correlationId,
        record.occurredAt?.toISOString() ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('audit insert returned no id');
    }
    return id;
  }
}
