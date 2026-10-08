import type { IdempotencyKeyScope, IdempotencyRepository, StoredIdempotencyRecord } from '@inspexor/application';
import type { IdempotencyRecordStatus } from '@inspexor/domain';
import type { Queryable } from './pg';

interface Row {
  id: string;
  request_hash: string;
  status: IdempotencyRecordStatus;
  expires_at: Date;
  response_status: number | null;
  response_body: unknown;
}

export class PgIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  async find(scope: IdempotencyKeyScope): Promise<StoredIdempotencyRecord | null> {
    const result = await this.db.query<Row>(
      `SELECT id, request_hash, status, expires_at, response_status, response_body
         FROM app.idempotency_records
        WHERE actor_id = $1 AND route = $2 AND idempotency_key = $3`,
      [scope.actorId, scope.route, scope.key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      requestHash: row.request_hash.trim(),
      status: row.status,
      expiresAt: row.expires_at,
      ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
      ...(row.response_body !== null ? { responseBody: row.response_body } : {}),
    };
  }

  async insertProcessing(scope: IdempotencyKeyScope, requestHash: string, expiresAt: Date): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO app.idempotency_records (actor_id, route, idempotency_key, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'PROCESSING', $5)
       ON CONFLICT (actor_id, route, idempotency_key) DO NOTHING
       RETURNING id`,
      [scope.actorId, scope.route, scope.key, requestHash, expiresAt.toISOString()],
    );
    return result.rows[0]?.id ?? null;
  }

  async restartProcessing(id: string, requestHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE app.idempotency_records
          SET request_hash = $2, status = 'PROCESSING', expires_at = $3, response_status = NULL, response_body = NULL
        WHERE id = $1`,
      [id, requestHash, expiresAt.toISOString()],
    );
  }

  async complete(id: string, responseStatus: number, responseBody: unknown): Promise<void> {
    await this.db.query(
      `UPDATE app.idempotency_records SET status = 'COMPLETED', response_status = $2, response_body = $3::jsonb WHERE id = $1`,
      [id, responseStatus, JSON.stringify(responseBody ?? null)],
    );
  }

  async fail(id: string): Promise<void> {
    await this.db.query(`UPDATE app.idempotency_records SET status = 'FAILED' WHERE id = $1`, [id]);
  }
}
