/**
 * G1 統合試験。CHG-006: Firestore（エミュレータ、無ければ MemoryDocStore）。
 *  - T-AUD-001   監査は追記のみ（更新・削除の経路を持たない。読出しで before/after を復元）
 *  - T-OUTBOX-001 業務更新と outbox が同一 transaction（失敗で両方とも残らない）
 *  - T-IDEM-001  Idempotency-Key: 初回/同一hash再送/異hash/処理中/期限切れ/並行
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendAudit, auditEventsFor, C, createUser, DocIdempotencyRepository, enqueueOutbox, findUserById, type OutboxDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { beginIdempotentRequest, computeRequestHash } from '../idempotency/idempotency-service';

let t: TestStore;
let userId: string;

beforeAll(async () => {
  t = createTestStore('foundation');
  userId = (await createUser(t.store, { loginId: 'itest-user', passwordHash: 'x', displayName: 'user', roles: ['OFFICE'] }, new Date())) as string;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('T-AUD-001: 監査（追記のみ）', () => {
  it('追記した監査は before/after・理由・相関IDとともに読み出せる', async () => {
    const correlationId = randomUUID();
    await t.store.runTransaction(async (tx) => {
      appendAudit(tx, { actorId: userId, action: 'X_UPDATE', targetType: 'USER', targetId: userId, beforeData: { v: 1 }, afterData: { v: 2 }, reason: '試験', correlationId }, new Date());
    });
    const rows = await auditEventsFor(t.store, 'USER', userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'X_UPDATE', actorId: userId, reason: '試験', correlationId, beforeData: { v: 1 }, afterData: { v: 2 } });
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
    const before = (await findUserById(t.store, userId))?.version ?? 0;
    await t.store.runTransaction(async (tx) => {
      tx.update(`${C.users}/${userId}`, { version: before + 1 });
      enqueueOutbox(tx, event, new Date());
    });
    const ob = await t.store.get<OutboxDoc>(`${C.outbox}/${event.eventId}`);
    expect(ob).toMatchObject({ type: 'RecordApproved', status: 'PENDING' });
    expect(JSON.parse(ob?.envelopeJson ?? '{}')).toMatchObject({ correlationId: event.correlationId, causationId: null, version: 1 });
    expect((await findUserById(t.store, userId))?.version).toBe(before + 1);
  });

  it('業務処理が失敗すると outbox も rollback される', async () => {
    const event = envelope(userId);
    const before = (await findUserById(t.store, userId))?.version;
    await expect(
      t.store.runTransaction(async (tx) => {
        tx.update(`${C.users}/${userId}`, { version: (before ?? 0) + 1 });
        enqueueOutbox(tx, event, new Date());
        throw new Error('domain invariant violated');
      }),
    ).rejects.toThrow('domain invariant violated');
    expect(await t.store.get(`${C.outbox}/${event.eventId}`)).toBeNull();
    expect((await findUserById(t.store, userId))?.version).toBe(before);
  });
});

describe('T-IDEM-001: Idempotency-Key', () => {
  const NOW = new Date('2026-10-08T04:00:00.000Z');
  const scope = (key: string) => ({ actorId: userId, route: 'POST /billing-runs', key });

  it('初回PROCEED → 完了後の同一hash再送はREPLAY（同応答）', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const hash = computeRequestHash('POST', '/billing-runs', { customerId: 'c', periodEnd: '2026-09-30' });
    const first = await beginIdempotentRequest(repo, scope('key-replay-000001'), hash, NOW);
    expect(first.kind).toBe('PROCEED');
    if (first.kind !== 'PROCEED') return;
    await repo.complete(first.recordId, 201, { data: { id: 'run-1' } });

    const second = await beginIdempotentRequest(repo, scope('key-replay-000001'), hash, NOW);
    expect(second).toEqual({ kind: 'REPLAY', responseStatus: 201, responseBody: { data: { id: 'run-1' } } });
  });

  it('同一key・異payloadはCONFLICT（409）', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const h1 = computeRequestHash('POST', '/billing-runs', { a: 1 });
    const h2 = computeRequestHash('POST', '/billing-runs', { a: 2 });
    await beginIdempotentRequest(repo, scope('key-conflict-00001'), h1, NOW);
    expect((await beginIdempotentRequest(repo, scope('key-conflict-00001'), h2, NOW)).kind).toBe('CONFLICT');
  });

  it('処理中（PROCESSING）の同一requestはIN_PROGRESS', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const h = computeRequestHash('POST', '/billing-runs', { a: 3 });
    await beginIdempotentRequest(repo, scope('key-inprogress-001'), h, NOW);
    expect((await beginIdempotentRequest(repo, scope('key-inprogress-001'), h, NOW)).kind).toBe('IN_PROGRESS');
  });

  it('並行requestでも PROCEED は1件だけ（一意制約）', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const h = computeRequestHash('POST', '/billing-runs', { a: 4 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => beginIdempotentRequest(repo, scope('key-concurrent-01'), h, NOW)),
    );
    expect(results.filter((r) => r.kind === 'PROCEED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'IN_PROGRESS')).toHaveLength(4);
  });

  it('24時間経過後は新規requestとしてPROCEED', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const h1 = computeRequestHash('POST', '/billing-runs', { a: 5 });
    const first = await beginIdempotentRequest(repo, scope('key-expired-00001'), h1, NOW);
    if (first.kind === 'PROCEED') await repo.complete(first.recordId, 201, { ok: true });
    const later = new Date(NOW.getTime() + 24 * 60 * 60_000 + 1);
    const h2 = computeRequestHash('POST', '/billing-runs', { a: 6 });
    expect((await beginIdempotentRequest(repo, scope('key-expired-00001'), h2, later)).kind).toBe('PROCEED');
  });

  it('actorが違えば同一keyでも独立（actor+route+key一意）', async () => {
    const repo = new DocIdempotencyRepository(t.store);
    const other = (await createUser(t.store, { loginId: 'itest-other', passwordHash: 'x', displayName: 'other', roles: ['OFFICE'] }, NOW)) as string;
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
