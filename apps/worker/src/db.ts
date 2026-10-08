import pg from 'pg';

// PostgreSQL date（OID 1082）は 'YYYY-MM-DD' 文字列のまま扱う（web と同じ）
pg.types.setTypeParser(1082, (value: string) => value);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 4 });
}

export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** audit（append-only）。worker の処理は SYSTEM（actor_id NULL） */
export async function appendAudit(
  db: Queryable,
  e: { action: string; targetType: string; targetId: string; beforeData?: unknown; afterData?: unknown; reason?: string | null; correlationId: string; occurredAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_events (actor_id, action, target_type, target_id, before_data, after_data, reason, correlation_id, occurred_at)
     VALUES (NULL, $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
    [e.action, e.targetType, e.targetId, e.beforeData === undefined ? null : JSON.stringify(e.beforeData), e.afterData === undefined ? null : JSON.stringify(e.afterData), e.reason ?? null, e.correlationId, e.occurredAt.toISOString()],
  );
}

/** outbox（API設計書 §Event envelope を payload に保存: GAP-012） */
export async function enqueueEvent(
  db: Queryable,
  e: { eventId: string; type: string; aggregateType: string; aggregateId: string; correlationId: string; causationId: string | null; occurredAt: Date; payload: Record<string, unknown> },
): Promise<void> {
  const envelope = { eventId: e.eventId, type: e.type, version: 1, occurredAt: e.occurredAt.toISOString(), aggregateType: e.aggregateType, aggregateId: e.aggregateId, correlationId: e.correlationId, causationId: e.causationId, payload: e.payload };
  await db.query(
    `INSERT INTO app.outbox_events (id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [e.eventId, e.type, e.aggregateType, e.aggregateId, JSON.stringify(envelope)],
  );
}
