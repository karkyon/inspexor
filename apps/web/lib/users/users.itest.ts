/**
 * CHG-008 統合試験: 利用者管理（API-030〜033）と、無効化・ロール変更・パスワード再設定後のセッション無効化（user-guard）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { RoleCode } from '@inspexor/domain';
import { auditEventsFor, C, createUser, StoreAuditRepository, type UserDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { issueSessionToken } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';
import { createUserGuard } from '../auth/user-guard';
import { handleMeRequest } from '../auth/me-handler';
import { UserService } from './user-service';
import { userActionHandlers, userCollectionHandlers, userItemHandlers, type UserRouteDeps } from './user-handlers';

const SECRET = 'u'.repeat(32);
const NOW = new Date('2026-10-11T03:00:00.000Z');
let t: TestStore;
let deps: UserRouteDeps;
let guard: ReturnType<typeof createUserGuard>;
const ids: Record<string, string> = {};

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const userSchema = ajv.getSchema('o#/components/schemas/User');

beforeAll(async () => {
  t = createTestStore('users');
  for (const [login, role] of [['admin', 'ADMIN'], ['office', 'OFFICE'], ['field', 'FIELD']] as const) {
    ids[login] = (await createUser(t.store, { loginId: `us-${login}`, passwordHash: 'x', displayName: login, roles: [role] }, NOW)) as string;
  }
  guard = createUserGuard(() => t.store, () => NOW.getTime());
  deps = {
    service: () => new UserService(t.store, async (p) => `hashed:${p.length}`),
    api: () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: new StoreAuditRepository(t.store, () => NOW), logError: () => undefined, userGuard: guard }),
  };
}, 60_000);

afterAll(async () => {
  await t?.close();
});

function req(userId: string, roles: RoleCode[], method: string, path: string, body?: unknown, issuedAt = '2026-10-11T02:55:00.000Z'): Request {
  const payload = { sessionId: `s-${userId}`, userId, displayName: 'x', roles, issuedAt, lastActivityAt: issuedAt };
  return new Request(`https://example.com/api/v1/${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`, 'x-csrf-token': issueCsrfToken(`s-${userId}`, SECRET), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const admin = (method: string, path: string, body?: unknown) => req(ids['admin'] as string, ['ADMIN'], method, path, body);
type Json = { data?: Record<string, unknown> & { id: string; version: number }; error?: { code: string; fields?: Array<{ path: string; code: string }> } };
const json = async (r: Response) => (await r.json()) as Json;

describe('CHG-008: 利用者管理（API-030〜033）', () => {
  it('ADMIN が作成（パスワードは保存しても応答・監査に出さない）。ログインID重複・短いパスワード・未知の項目は 422', async () => {
    const res = await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'tanaka.k', displayName: '田中 一郎', roles: ['FIELD'], password: 'correct-horse-1' }));
    expect(res.status).toBe(201);
    const u = (await json(res)).data as Record<string, unknown> & { id: string };
    expect(userSchema?.(u), JSON.stringify(userSchema?.errors)).toBe(true);
    expect(u).toMatchObject({ loginId: 'tanaka.k', status: 'ACTIVE', locked: false, version: 1, roles: ['FIELD'] });
    expect(JSON.stringify(u)).not.toContain('correct-horse');
    const stored = (await t.store.get<UserDoc>(`${C.users}/${u.id}`)) as UserDoc;
    expect(stored.passwordHash).toBe('hashed:15');
    const audits = await auditEventsFor(t.store, 'USER', u.id);
    expect(audits.map((a) => a.action)).toEqual(['USER_CREATE']);
    expect(JSON.stringify(audits)).not.toContain('correct-horse');
    ids['tanaka'] = u.id;
    const dup = await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'tanaka.k', displayName: 'x', roles: ['FIELD'], password: 'correct-horse-1' }));
    expect(dup.status).toBe(422);
    expect((await json(dup)).error?.fields?.[0]).toMatchObject({ path: '/loginId', code: 'duplicate' });
    expect((await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'sato', displayName: 'x', roles: ['FIELD'], password: 'short' }))).status).toBe(422);
    expect((await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'sato', displayName: 'x', roles: [], password: 'correct-horse-1' }))).status).toBe(422);
    expect((await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'sato', displayName: 'x', roles: ['FIELD'], password: 'correct-horse-1', status: 'ACTIVE' }))).status).toBe(422);
  });

  it('一覧はログインID順。OFFICE は参照のみ（作成 403）、FIELD は 403', async () => {
    const list = await json(await userCollectionHandlers(deps).GET(req(ids['office'] as string, ['OFFICE'], 'GET', 'users')));
    const logins = (list.data as unknown as Array<{ loginId: string }>).map((x) => x.loginId);
    expect(logins).toEqual([...logins].sort());
    expect(logins).toContain('tanaka.k');
    expect((await userCollectionHandlers(deps).POST(req(ids['office'] as string, ['OFFICE'], 'POST', 'users', { loginId: 'x1x', displayName: 'x', roles: ['FIELD'], password: 'correct-horse-1' }))).status).toBe(403);
    expect((await userCollectionHandlers(deps).GET(req(ids['field'] as string, ['FIELD'], 'GET', 'users'))).status).toBe(403);
  });

  it('ロール変更で既存セッションは使えない（401）。表示名だけの変更は維持。version 不一致は 409', async () => {
    const id = ids['tanaka'] as string;
    const meOk = await handleMeRequest(req(id, ['FIELD'], 'GET', 'me'), { sessionSecret: SECRET, now: () => NOW, userGuard: guard });
    expect(meOk.status).toBe(200);
    const r1 = await userItemHandlers(deps).PATCH(admin('PATCH', `users/${id}`, { expectedVersion: 1, displayName: '田中 一郎（現場）', roles: ['FIELD'] }));
    expect(r1.status).toBe(200);
    expect((await handleMeRequest(req(id, ['FIELD'], 'GET', 'me'), { sessionSecret: SECRET, now: () => NOW, userGuard: guard })).status).toBe(200);
    expect((await userItemHandlers(deps).PATCH(admin('PATCH', `users/${id}`, { expectedVersion: 1, displayName: 'x', roles: ['FIELD'] }))).status).toBe(409);
    const r2 = await userItemHandlers(deps).PATCH(admin('PATCH', `users/${id}`, { expectedVersion: 2, displayName: '田中 一郎', roles: ['FIELD', 'OFFICE'] }));
    expect(r2.status).toBe(200);
    expect((await json(r2)).data).toMatchObject({ version: 3, roles: ['FIELD', 'OFFICE'] });
    expect((await handleMeRequest(req(id, ['FIELD'], 'GET', 'me'), { sessionSecret: SECRET, now: () => NOW, userGuard: guard })).status).toBe(401);
    // 変更後に発行されたセッションは使える
    expect((await userCollectionHandlers(deps).GET(req(id, ['OFFICE'], 'GET', 'users', undefined, '2026-10-11T03:00:00.000Z'))).status).toBe(200);
  });

  it('無効化で既存セッションは 401、ログインもできない状態。有効化で戻る。理由は監査に残る', async () => {
    const id = ids['tanaka'] as string;
    const d = await json(await userActionHandlers(deps).POST(admin('POST', `users/${id}/deactivate`, { expectedVersion: 3, reason: '退職' })));
    expect(d.data).toMatchObject({ status: 'INACTIVE', version: 4 });
    expect((await userCollectionHandlers(deps).GET(req(id, ['OFFICE'], 'GET', 'users', undefined, '2026-10-11T03:00:00.000Z'))).status).toBe(401);
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${id}/deactivate`, { expectedVersion: 4 }))).status).toBe(409);
    const a = await json(await userActionHandlers(deps).POST(admin('POST', `users/${id}/activate`, { expectedVersion: 4 })));
    expect(a.data).toMatchObject({ status: 'ACTIVE', version: 5 });
    const audits = await auditEventsFor(t.store, 'USER', id);
    expect(audits.find((x) => x.action === 'USER_DEACTIVATE')?.reason).toBe('退職');
  });

  it('パスワード再設定（12文字以上必須）でロックも解除し、既存セッションは 401。ロック解除だけも可能', async () => {
    const id = ids['tanaka'] as string;
    await t.store.runTransaction(async (tx) => tx.update(`${C.users}/${id}`, { failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 600_000) }));
    const list = await json(await userCollectionHandlers(deps).GET(admin('GET', 'users')));
    expect((list.data as unknown as Array<{ id: string; locked: boolean }>).find((x) => x.id === id)?.locked).toBe(true);
    const u = await json(await userActionHandlers(deps).POST(admin('POST', `users/${id}/unlock`, { expectedVersion: 5 })));
    expect(u.data).toMatchObject({ locked: false, version: 6 });
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${id}/reset-password`, { expectedVersion: 6 }))).status).toBe(422);
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${id}/reset-password`, { expectedVersion: 6, password: 'short' }))).status).toBe(422);
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${id}/unlock`, { expectedVersion: 6, password: 'new-password-12' }))).status).toBe(422);
    const r = await userActionHandlers(deps).POST(admin('POST', `users/${id}/reset-password`, { expectedVersion: 6, password: 'new-password-12' }));
    expect(r.status).toBe(200);
    expect(((await t.store.get<UserDoc>(`${C.users}/${id}`)) as UserDoc).passwordHash).toBe('hashed:15');
    expect((await userCollectionHandlers(deps).GET(req(id, ['OFFICE'], 'GET', 'users'))).status).toBe(401);
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${id}/delete`, { expectedVersion: 7 }))).status).toBe(404);
  });

  it('自分の無効化・自分の ADMIN 外し・有効な ADMIN が0人になる変更は 422', async () => {
    const me = ids['admin'] as string;
    expect((await userActionHandlers(deps).POST(admin('POST', `users/${me}/deactivate`, { expectedVersion: 1 }))).status).toBe(422);
    expect((await userItemHandlers(deps).PATCH(admin('PATCH', `users/${me}`, { expectedVersion: 1, displayName: 'admin', roles: ['OFFICE'] }))).status).toBe(422);
    // 2人目の ADMIN を作れば、1人目（自分以外として）の ADMIN を外せる
    const second = await json(await userCollectionHandlers(deps).POST(admin('POST', 'users', { loginId: 'admin2', displayName: '管理者2', roles: ['ADMIN'], password: 'correct-horse-2' })));
    const sid = second.data?.id as string;
    const byOther = req(sid, ['ADMIN'], 'PATCH', `users/${me}`, { expectedVersion: 1, displayName: 'admin', roles: ['OFFICE'] }, '2026-10-11T03:00:00.000Z');
    expect((await userItemHandlers(deps).PATCH(byOther)).status).toBe(200);
    // 残る ADMIN（admin2）を、他の ADMIN がいない状態で外すことはできない（自分自身でもある）
    expect((await userItemHandlers(deps).PATCH(req(sid, ['ADMIN'], 'PATCH', `users/${sid}`, { expectedVersion: 1, displayName: 'x', roles: ['OFFICE'] }, '2026-10-11T03:00:00.000Z'))).status).toBe(422);
  });
});
