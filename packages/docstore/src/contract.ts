/**
 * DocStore の契約試験（MemoryDocStore と Firestore エミュレータの両方で同じ結果になること）。
 * docstore.test.ts（memory）と docstore.itest.ts（エミュレータ、無ければ memory）から呼ぶ。
 */
import { describe, expect, it } from 'vitest';
import { DocIdempotencyRepository, appendAudit, auditEventsFor, claimUnique, enqueueOutbox, readCounter, readUniqueOwner, writeCounter, C, type OutboxDoc } from './repos';
import { createUser, DocUserRepository, findUserById } from './users';
import { DocStoreError, safeId, type DocStore } from './types';

export function docStoreContract(name: string, make: () => { store: DocStore; kind: 'emulator' | 'memory' }): void {
  describe(`DocStore 契約（${name}）`, () => {
    it('create / get / 存在する文書への create は ALREADY_EXISTS、無い文書の update は NOT_FOUND', async () => {
      const { store } = make();
      await store.runTransaction(async (tx) => tx.create('items/a', { n: 1, s: 'x', at: new Date('2026-10-09T00:00:00Z'), nested: { k: [1, 2] }, skip: undefined }));
      const got = await store.get<{ n: number; s: string; at: Date; nested: { k: number[] }; skip?: unknown }>('items/a');
      expect(got).toEqual({ n: 1, s: 'x', at: new Date('2026-10-09T00:00:00Z'), nested: { k: [1, 2] } });
      expect(got?.at).toBeInstanceOf(Date);
      expect('skip' in (got ?? {})).toBe(false);
      await expect(store.runTransaction(async (tx) => tx.create('items/a', { n: 2 }))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await expect(store.runTransaction(async (tx) => tx.update('items/zzz', { n: 2 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await store.get('items/zzz')).toBeNull();
    });

    it('update は先頭階層の項目を置き換え、他の項目は残す（入れ子 object は丸ごと置換）', async () => {
      const { store } = make();
      await store.runTransaction(async (tx) => tx.create('items/u', { a: 1, m: { x: 1, y: 2 }, keep: true }));
      await store.runTransaction(async (tx) => tx.update('items/u', { a: 2, m: { x: 9 } }));
      expect(await store.get('items/u')).toEqual({ a: 2, m: { x: 9 }, keep: true });
    });

    it('transaction: 例外なら何も反映しない、書込の後の読込は禁止', async () => {
      const { store } = make();
      await expect(
        store.runTransaction(async (tx) => {
          tx.create('items/r1', { v: 1 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await store.get('items/r1')).toBeNull();
      await expect(
        store.runTransaction(async (tx) => {
          tx.set('items/r2', { v: 1 });
          await tx.get('items/r2');
        }),
      ).rejects.toThrow();
      expect(await store.get('items/r2')).toBeNull();
    });

    it('一部の create が衝突したら transaction 全体が反映されない', async () => {
      const { store } = make();
      await store.runTransaction(async (tx) => tx.create('items/dup', { v: 1 }));
      await expect(
        store.runTransaction(async (tx) => {
          tx.create('items/new1', { v: 1 });
          tx.create('items/dup', { v: 2 });
        }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(await store.get('items/new1')).toBeNull();
      expect(await store.get('items/dup')).toEqual({ v: 1 });
    });

    it('配列の入れ子・不正な項目名は保存できない', async () => {
      const { store } = make();
      await expect(store.runTransaction(async (tx) => tx.create('items/bad', { a: [[1]] }))).rejects.toBeInstanceOf(DocStoreError);
      await expect(store.runTransaction(async (tx) => tx.create('items/bad2', { 'a.b': 1 }))).rejects.toBeInstanceOf(DocStoreError);
    });

    it('検索: ==、範囲（並び順は範囲の項目→文書ID）、in、array-contains、limit、並び順の項目が無い文書は除外', async () => {
      const { store } = make();
      await store.runTransaction(async (tx) => {
        tx.create('q/1', { d: '2026-10-01', c: 'A', tags: ['p1', 'p2'], n: 3 });
        tx.create('q/2', { d: '2026-10-05', c: 'B', tags: ['p2'], n: 1 });
        tx.create('q/3', { d: '2026-10-05', c: 'A', tags: [], n: 2 });
        tx.create('q/4', { d: '2026-11-01', c: 'A', tags: ['p1'], n: 5 });
        tx.create('q/5', { c: 'A', tags: ['p1'] });
      });
      const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
      expect(ids(await store.query('q', { where: [{ field: 'c', op: '==', value: 'A' }] }))).toEqual(['1', '3', '4', '5']);
      expect(ids(await store.query('q', { where: [{ field: 'd', op: '>=', value: '2026-10-01' }, { field: 'd', op: '<=', value: '2026-10-31' }] }))).toEqual(['1', '2', '3']);
      expect(ids(await store.query('q', { where: [{ field: 'd', op: '<', value: '2026-12-01' }], orderBy: [{ field: 'd', dir: 'desc' }], limit: 2 }))).toEqual(['4', '3']);
      expect(ids(await store.query('q', { where: [{ field: 'c', op: 'in', value: ['B', 'Z'] }] }))).toEqual(['2']);
      expect(ids(await store.query('q', { where: [{ field: 'tags', op: 'array-contains', value: 'p1' }] }))).toEqual(['1', '4', '5']);
      expect(ids(await store.query('q', { orderBy: [{ field: 'n' }] }))).toEqual(['2', '3', '1', '4']);
      // 範囲条件は同じ型の値だけに一致（数値の項目に文字列で比較しても一致しない）
      expect(ids(await store.query('q', { where: [{ field: 'n', op: '>', value: '0' }] }))).toEqual([]);
    });

    it('一意キー・採番', async () => {
      const { store } = make();
      await store.runTransaction(async (tx) => {
        expect(await readUniqueOwner(tx, 'code', 'cust1', 'A/1.2')).toBeNull();
        claimUnique(tx, 'code', 'cust1', 'A/1.2', 'owner-1');
      });
      await store.runTransaction(async (tx) => {
        expect(await readUniqueOwner(tx, 'code', 'cust1', 'A/1.2')).toBe('owner-1');
        expect(await readUniqueOwner(tx, 'code', 'cust2', 'A/1.2')).toBeNull();
      });
      await expect(store.runTransaction(async (tx) => claimUnique(tx, 'code', 'cust1', 'A/1.2', 'owner-2'))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      for (let i = 0; i < 3; i += 1) {
        await store.runTransaction(async (tx) => writeCounter(tx, 'WR-202610', (await readCounter(tx, 'WR-202610')) + 1));
      }
      expect(await store.runTransaction(async (tx) => readCounter(tx, 'WR-202610'))).toBe(3);
      expect(safeId('..')).not.toBe('..');
      expect(safeId('a/b')).not.toContain('/');
    });

    it('並行した採番でも重複しない（transaction の再試行）', async () => {
      const { store } = make();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.runTransaction(async (tx) => {
            const next = (await readCounter(tx, 'DR-202610')) + 1;
            writeCounter(tx, 'DR-202610', next);
            return next;
          }),
        ),
      );
      expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    it('監査（追記）と outbox', async () => {
      const { store } = make();
      const now = new Date('2026-10-09T01:00:00Z');
      await store.runTransaction(async (tx) => {
        appendAudit(tx, { actorId: 'u1', action: 'X_UPDATE', targetType: 'X', targetId: 't1', beforeData: { a: [[1]] }, afterData: { a: 2 }, reason: '理由', correlationId: 'c1' }, now);
        enqueueOutbox(tx, { eventId: 'e1', type: 'WorkReportConfirmed', version: 1, occurredAt: now.toISOString(), aggregateType: 'WORK_REPORT', aggregateId: 't1', correlationId: 'c1', causationId: null, payload: { revisionId: 'r1' } }, now);
      });
      const audits = await auditEventsFor(store, 'X', 't1');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.beforeData).toEqual({ a: [[1]] });
      expect(audits[0]?.reason).toBe('理由');
      const ob = await store.get<OutboxDoc>(`${C.outbox}/e1`);
      expect(ob?.status).toBe('PENDING');
      expect(JSON.parse(ob?.envelopeJson ?? '{}').payload).toEqual({ revisionId: 'r1' });
    });

    it('冪等性: 同じ scope の二重作成は null、complete で応答を保存', async () => {
      const { store } = make();
      const repo = new DocIdempotencyRepository(store);
      const scope = { actorId: 'u1', route: 'POST /x', key: 'k1' };
      const exp = new Date('2026-10-10T00:00:00Z');
      const id = await repo.insertProcessing(scope, 'h1', exp);
      expect(id).not.toBeNull();
      expect(await repo.insertProcessing(scope, 'h1', exp)).toBeNull();
      await repo.complete(id as string, 202, { data: { ok: true, list: [1, 2] } });
      const found = await repo.find(scope);
      expect(found).toMatchObject({ status: 'COMPLETED', responseStatus: 202, responseBody: { data: { ok: true, list: [1, 2] } }, requestHash: 'h1' });
      expect(found?.expiresAt.toISOString()).toBe(exp.toISOString());
      await repo.restartProcessing(id as string, 'h2', exp);
      expect(await repo.find(scope)).toMatchObject({ status: 'PROCESSING', requestHash: 'h2' });
      await repo.fail(id as string);
      expect((await repo.find(scope))?.status).toBe('FAILED');
    });

    it('ユーザー: 作成・ログインIDで検索・重複は null・ロックアウト更新', async () => {
      const { store } = make();
      const now = new Date('2026-10-09T00:00:00Z');
      const id = await createUser(store, { loginId: 'dev-x', passwordHash: 'h', displayName: '試験', roles: ['FIELD'] }, now);
      expect(id).not.toBeNull();
      expect(await createUser(store, { loginId: 'dev-x', passwordHash: 'h2', displayName: '重複', roles: ['ADMIN'] }, now)).toBeNull();
      const repo = new DocUserRepository(store, () => now);
      const u = await repo.findByLoginId('dev-x');
      expect(u).toMatchObject({ id, loginId: 'dev-x', displayName: '試験', status: 'ACTIVE', roles: ['FIELD'], failedAttempts: 0, lockedUntil: null });
      expect(await repo.findByLoginId('nobody')).toBeNull();
      const until = new Date('2026-10-09T00:15:00Z');
      await repo.updateLockoutState(id as string, { failedAttempts: 5, lockedUntil: until });
      expect(await findUserById(store, id as string)).toMatchObject({ failedAttempts: 5, lockedUntil: until });
    });
  });
}
