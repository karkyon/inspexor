/**
 * G1 統合試験（実PostgreSQL 16 / fresh DB = schema.sql のみから構築）
 *  - T-AUD-001   audit_events append-only（UPDATE/DELETE は trigger で 55000 拒否）
 *  - T-OUTBOX-001 業務更新と outbox が同一TX（rollback で outbox も消える）
 *  - T-IDEM-001  Idempotency-Key: 初回/同一hash再送/異hash/処理中/期限切れ
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFreshDatabase, insertUser, type FreshDatabase } from '../testing/fresh-db';
import { withTransaction } from './pg';
import { PgAuditRepository } from './pg-audit-repository';
import { PgOutboxRepository } from './pg-outbox-repository';
import { PgIdempotencyRepository } from './pg-idempotency-repository';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';

let db: FreshDatabase;
let userId: string;

beforeAll(async () => {
  db = await createFreshDatabase('foundation');
  userId = await insertUser(db.pool, 'itest-user');
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('fresh DB', () => {
  it('schema.sql から app スキーマ業務34テーブルが作成される', async () => {
    const r = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'app' AND table_name <> 'schema_migrations'`,
    );
    expect(r.rows[0]?.n).toBe('34');
  });

  it('追記migration（CHG-001）が適用・記録されている', async () => {
    const r = await db.pool.query<{ id: string }>(`SELECT id FROM app.schema_migrations ORDER BY id`);
    expect(r.rows.map((row) => row.id)).toContain('0001_chg001_master_columns');
  });
});

describe('T-AUD-001: audit_events append-only', () => {
  it('appendでき、UPDATE/DELETEは55000で拒否される', async () => {
    const repo = new PgAuditRepository(db.pool);
    const correlationId = randomUUID();
    const id = await repo.append({
      actorId: userId,
      action: 'AUTHZ_DENIED',
      targetType: 'USER',
      targetId: userId,
      afterData: { operationId: 'createMaster' },
      correlationId,
    });
    const row = await db.pool.query(`SELECT action, after_data, correlation_id FROM app.audit_events WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ action: 'AUTHZ_DENIED', correlation_id: correlationId, after_data: { operationId: 'createMaster' } });

    await expect(db.pool.query(`UPDATE app.audit_events SET action = 'X' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '55000' });
    await expect(db.pool.query(`DELETE FROM app.audit_events WHERE id = $1`, [id])).rejects.toMatchObject({ code: '55000' });
  });

  it('correlation_id はuuid必須（不正値は拒否）', async () => {
    const repo = new PgAuditRepository(db.pool);
    await expect(
      repo.append({ actorId: userId, action: 'X', targetType: 'USER', targetId: userId, correlationId: 'not-a-uuid' }),
    ).rejects.toBeDefined();
  });
});

describe('T-OUTBOX-001: 業務更新とoutboxは同一TX', () => {
  const envelope = (aggregateId: string) => ({
    eventId: randomUUID(),
    type: 'RecordApproved' as const,
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'USER',
    aggregateId,
    correlationId: randomUUID(),
    causationId: null,
    payload: { note: 'itest' },
  });

  it('commit時は業務更新とoutboxが両方残る', async () => {
    const event = envelope(userId);
    await withTransaction(db.pool, async (client) => {
      await client.query(`UPDATE app.users SET version = version + 1 WHERE id = $1`, [userId]);
      await new PgOutboxRepository(client).enqueue(event);
    });
    const r = await db.pool.query(`SELECT event_type, status, payload FROM app.outbox_events WHERE id = $1`, [event.eventId]);
    expect(r.rows[0]).toMatchObject({ event_type: 'RecordApproved', status: 'PENDING' });
    expect(r.rows[0].payload).toMatchObject({ correlationId: event.correlationId, causationId: null, version: 1 });
  });

  it('業務処理が失敗すると outbox も rollback される', async () => {
    const event = envelope(userId);
    const before = await db.pool.query<{ version: number }>(`SELECT version FROM app.users WHERE id = $1`, [userId]);
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(`UPDATE app.users SET version = version + 1 WHERE id = $1`, [userId]);
        await new PgOutboxRepository(client).enqueue(event);
        throw new Error('domain invariant violated');
      }),
    ).rejects.toThrow('domain invariant violated');
    const outbox = await db.pool.query(`SELECT 1 FROM app.outbox_events WHERE id = $1`, [event.eventId]);
    expect(outbox.rowCount).toBe(0);
    const after = await db.pool.query<{ version: number }>(`SELECT version FROM app.users WHERE id = $1`, [userId]);
    expect(after.rows[0]?.version).toBe(before.rows[0]?.version);
  });
});

describe('T-IDEM-001: Idempotency-Key', () => {
  const NOW = new Date('2026-10-08T04:00:00.000Z');
  const scope = (key: string) => ({ actorId: userId, route: 'POST /billing-runs', key });

  it('初回PROCEED → 完了後の同一hash再送はREPLAY（同応答）', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const hash = computeRequestHash('POST', '/billing-runs', { customerId: 'c', periodEnd: '2026-09-30' });
    const first = await beginIdempotentRequest(repo, scope('key-replay-000001'), hash, NOW);
    expect(first.kind).toBe('PROCEED');
    if (first.kind !== 'PROCEED') return;
    await repo.complete(first.recordId, 201, { data: { id: 'run-1' } });

    const second = await beginIdempotentRequest(repo, scope('key-replay-000001'), hash, NOW);
    expect(second).toEqual({ kind: 'REPLAY', responseStatus: 201, responseBody: { data: { id: 'run-1' } } });
  });

  it('同一key・異payloadはCONFLICT（409）', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const h1 = computeRequestHash('POST', '/billing-runs', { a: 1 });
    const h2 = computeRequestHash('POST', '/billing-runs', { a: 2 });
    await beginIdempotentRequest(repo, scope('key-conflict-00001'), h1, NOW);
    expect((await beginIdempotentRequest(repo, scope('key-conflict-00001'), h2, NOW)).kind).toBe('CONFLICT');
  });

  it('処理中（PROCESSING）の同一requestはIN_PROGRESS', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const h = computeRequestHash('POST', '/billing-runs', { a: 3 });
    await beginIdempotentRequest(repo, scope('key-inprogress-001'), h, NOW);
    expect((await beginIdempotentRequest(repo, scope('key-inprogress-001'), h, NOW)).kind).toBe('IN_PROGRESS');
  });

  it('並行requestでも PROCEED は1件だけ（一意制約）', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const h = computeRequestHash('POST', '/billing-runs', { a: 4 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => beginIdempotentRequest(repo, scope('key-concurrent-01'), h, NOW)),
    );
    expect(results.filter((r) => r.kind === 'PROCEED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'IN_PROGRESS')).toHaveLength(4);
  });

  it('24時間経過後は新規requestとしてPROCEED', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const h1 = computeRequestHash('POST', '/billing-runs', { a: 5 });
    const first = await beginIdempotentRequest(repo, scope('key-expired-00001'), h1, NOW);
    if (first.kind === 'PROCEED') await repo.complete(first.recordId, 201, { ok: true });
    const later = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
    const h2 = computeRequestHash('POST', '/billing-runs', { a: 6 });
    expect((await beginIdempotentRequest(repo, scope('key-expired-00001'), h2, later)).kind).toBe('PROCEED');
  });

  it('actorが違えば同一keyでも独立（actor+route+key一意）', async () => {
    const repo = new PgIdempotencyRepository(db.pool);
    const other = await insertUser(db.pool, 'itest-other');
    const h = computeRequestHash('POST', '/billing-runs', { a: 7 });
    expect((await beginIdempotentRequest(repo, scope('key-shared-000001'), h, NOW)).kind).toBe('PROCEED');
    expect(
      (await beginIdempotentRequest(repo, { actorId: other, route: 'POST /billing-runs', key: 'key-shared-000001' }, h, NOW)).kind,
    ).toBe('PROCEED');
  });

  it('request hashはキー順に依存しない', () => {
    expect(computeRequestHash('POST', '/x', { a: 1, b: { c: 2, d: 3 } })).toBe(
      computeRequestHash('POST', '/x', { b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
