import { afterAll, describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { createUser, DocUserRepository, findUserById } from '@inspexor/docstore';
import { createTestStore } from '@inspexor/docstore/testing';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { handleLoginRequest } from './login-handler';

// CHG-006 g20: ログイン API（API-001）を Firestore のユーザーで動かす（エミュレータ、無ければ memory）
const t = createTestStore('login');
const secret = 's'.repeat(48);
let now = new Date('2026-10-09T00:00:00Z');

function post(body: unknown): Request {
  return new Request('http://localhost/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const deps = () => ({ userRepository: new DocUserRepository(t.store, () => now), passwordHasher: new Argon2PasswordHasher(), sessionSecret: secret, now: () => now });

describe('API-001 ログイン（Firestore）', () => {
  afterAll(async () => t.close());

  it('正しいパスワードは 200＋セッション Cookie、誤りは 401、5回失敗で 423（ロック）、ロック解除後は成功で失敗回数 0', async () => {
    const id = await createUser(t.store, { loginId: 'itest-field', passwordHash: await argon2.hash('correct-horse-1', { type: argon2.argon2id }), displayName: '結合試験', roles: ['FIELD'] }, now);
    expect(id).not.toBeNull();

    const ok = await handleLoginRequest(post({ loginId: 'itest-field', password: 'correct-horse-1' }), deps());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^__Secure-inspexor\.session=/);
    const body = (await ok.json()) as { data: { userId: string; roles: string[] } };
    expect(body.data).toMatchObject({ userId: id, roles: ['FIELD'] });

    expect((await handleLoginRequest(post({ loginId: 'nobody', password: 'whatever-123' }), deps())).status).toBe(401);
    for (let i = 0; i < 5; i += 1) {
      expect((await handleLoginRequest(post({ loginId: 'itest-field', password: 'wrong-password' }), deps())).status).toBe(401);
    }
    expect((await handleLoginRequest(post({ loginId: 'itest-field', password: 'correct-horse-1' }), deps())).status).toBe(423);
    expect((await findUserById(t.store, id as string))?.failedAttempts).toBeGreaterThanOrEqual(5);

    now = new Date(now.getTime() + 60 * 60_000);
    expect((await handleLoginRequest(post({ loginId: 'itest-field', password: 'correct-horse-1' }), deps())).status).toBe(200);
    expect(await findUserById(t.store, id as string)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });
});
