import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

// PostgreSQL date（OID 1082）は JS Date に変換すると timezone でずれるため 'YYYY-MM-DD' 文字列のまま扱う
types.setTypeParser(1082, (value: string) => value);

/**
 * 業務テーブルへの書込は schema.sql（仕様正本 DB）の列名で parameterized SQL を発行する（SEC-008）。
 * Pool / PoolClient の両方を受けられるよう query だけを要求する。
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

const globalForPg = globalThis as unknown as { inspexorPgPool?: Pool };

export function getPool(): Pool {
  if (globalForPg.inspexorPgPool === undefined) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    globalForPg.inspexorPgPool = new Pool({ connectionString, max: 5 });
  }
  return globalForPg.inspexorPgPool;
}

/** BEGIN〜COMMIT。例外時はROLLBACKして再throw（00契約 不変条件4: 業務更新とoutboxは同一TX） */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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
