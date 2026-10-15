/**
 * CHG-012 統合試験: ログインの回数制限（SEC-009 / GAP-010）、管理者の多要素認証（SEC-004 / G1-03）、再認証（SEC-026）。
 * ログイン → 確認待ち → 登録（QR・回復コード）→ 確認コード／回復コード → session、ロック、管理者による解除、session の扱いを API で通しで確かめる。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { auditEventsFor, C, createUser, DocUserRepository, StoreAuditRepository, type UserDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { findSpecFile } from '../testing/spec-files';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { handleLoginRequest } from './login-handler';
import { handleMfaSetup, handleMfaVerify, mfaAccountHandlers, type MfaAccountDeps, type MfaPublicDeps } from './mfa-handlers';
import { MfaService, secretFromEnc } from './mfa-service';
import { base32Decode, totp } from './totp';
import { createUserGuard } from './user-guard';
import { verifySessionToken } from './session-token';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { handleMeRequest } from './me-handler';
import { issueCsrfToken } from '../security/csrf';
import { createLoginRateLimit, MemoryRateLimiter, clientIp } from '../security/rate-limit';
import { createApiHandler } from '../http/api-handler';
import { dataResponse } from '../http/api-response';
import { UserService } from '../users/user-service';
import { userActionHandlers, type UserRouteDeps } from '../users/user-handlers';

const SECRET = 'm'.repeat(48);
const PW = 'correct-horse-battery-1';
let now = new Date('2026-10-15T00:00:00.000Z');
let env: Record<string, string> = { ADMIN_MFA_ENABLED: 'true' };
let t: TestStore;
const ids: Record<string, string> = {};
const hasher = new Argon2PasswordHasher();

const doc = parse(readFileSync(findSpecFile('openapi.yaml', 'OPENAPI_PATH'), 'utf8')) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'o' });
const valid = (name: string, value: unknown) => {
  const fn = ajv.getSchema(`o#/components/schemas/${name}`);
  if (!fn) throw new Error(name);
  expect(fn(value), JSON.stringify(fn.errors)).toBe(true);
};

const mfa = () => new MfaService(t.store, SECRET, () => env);
const guard = () => createUserGuard(() => t.store, () => now.getTime(), { adminMfaEnabled: () => env['ADMIN_MFA_ENABLED'] === 'true' });
const api = () => ({ sessionSecret: SECRET, now: () => now, auditRepository: new StoreAuditRepository(t.store, () => now), logError: () => undefined, userGuard: guard() });
const loginDeps = (rateLimit?: ReturnType<typeof createLoginRateLimit>) => ({
  userRepository: new DocUserRepository(t.store, () => now),
  passwordHasher: hasher,
  sessionSecret: SECRET,
  now: () => now,
  mfa: mfa(),
  ...(rateLimit !== undefined ? { rateLimit } : {}),
});
const pub = (): MfaPublicDeps => ({ service: mfa, sessionSecret: () => SECRET, now: () => now });
const account = (): MfaAccountDeps => ({ service: mfa, hasher: () => hasher, api });

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
type Json = { data?: Record<string, unknown>; error?: { code: string; message: string; fields?: Array<{ path: string }>; challengeExpired?: boolean; reauthRequired?: boolean; retryAfterSeconds?: number } };
const json = async (r: Response) => (await r.json()) as Json;
const cookieOf = (r: Response): string => {
  const c = (r.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(c).toMatch(/^__Secure-inspexor\.session=/);
  return c;
};
const sessionOf = (cookie: string) => verifySessionToken(cookie.slice(`${SESSION_COOKIE_NAME}=`.length), SECRET);
function authed(cookie: string, method: string, path: string, body?: unknown): Request {
  const s = sessionOf(cookie);
  return new Request(`http://localhost/api/v1/${path}`, {
    method,
    headers: { cookie, 'x-csrf-token': issueCsrfToken(s?.sessionId as string, SECRET), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const login = (loginId: string, password = PW, rl?: ReturnType<typeof createLoginRateLimit>, headers: Record<string, string> = {}) => handleLoginRequest(post('auth/login', { loginId, password }, headers), loginDeps(rl));
const userDoc = async (id: string) => (await t.store.get<UserDoc>(`${C.users}/${id}`)) as UserDoc;
const codeFor = async (id: string, at = now) => totp(base32Decode(secretFromEnc((await userDoc(id)).mfa?.secretEnc as string, SECRET)), at.getTime());

beforeAll(async () => {
  t = createTestStore('security');
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  for (const [k, roles] of [['admin', ['ADMIN']], ['admin2', ['OFFICE', 'ADMIN']], ['office', ['OFFICE']], ['rl', ['FIELD']]] as const) {
    ids[k] = (await createUser(t.store, { loginId: `sec-${k}`, passwordHash: hash, displayName: k, roles: [...roles] }, now)) as string;
  }
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('CHG-012 ログインの回数制限（SEC-009）', () => {
  it('接続元は X-Forwarded-For の末尾（先頭は利用者が書ける）。無ければ local', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' } }))).toBe('203.0.113.9');
    expect(clientIp(new Request('http://x'))).toBe('local');
  });

  it('同じログインIDは上限を超えると 429 RATE_LIMITED（Retry-After）。区間が変われば戻る。別の接続元・別のIDは数えない', async () => {
    const rl = createLoginRateLimit(() => t.store, { ip: { limit: 100, windowMs: 600_000 }, id: { limit: 3, windowMs: 600_000 } });
    for (let i = 0; i < 3; i += 1) expect((await login('sec-rl', 'wrong-password-x', rl)).status).toBe(401);
    const res = await login('SEC-RL', PW, rl);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await json(res)).error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
    // 回数制限で拒否したときはパスワードを照合しない（失敗回数も増えない）
    expect((await userDoc(ids['rl'] as string)).failedAttempts).toBe(3);
    now = new Date(now.getTime() + 600_000);
    expect((await login('sec-rl', PW, rl)).status).toBe(200);
  });

  it('同じ接続元からは、ログインIDを変えても上限で 429', async () => {
    const rl = createLoginRateLimit(() => t.store, { ip: { limit: 2, windowMs: 600_000 }, id: { limit: 100, windowMs: 600_000 } });
    const h = { 'x-forwarded-for': '198.51.100.7' };
    expect((await login('nobody-1', PW, rl, h)).status).toBe(401);
    expect((await login('nobody-2', PW, rl, h)).status).toBe(401);
    expect((await login('nobody-3', PW, rl, h)).status).toBe(429);
    expect((await login('nobody-3', PW, rl, { 'x-forwarded-for': '198.51.100.8' })).status).toBe(401);
  });

  it('API 全般: 利用者ごとに更新・参照を別に数え、超えたら 429', async () => {
    const limiter = new MemoryRateLimiter({ command: { limit: 2, windowMs: 60_000 }, read: { limit: 3, windowMs: 60_000 } });
    const res = await login('sec-office');
    const cookie = cookieOf(res);
    const h = createApiHandler('getMe', async (ctx) => dataResponse(200, { ok: true }, ctx.correlationId), () => ({ ...api(), rateLimiter: limiter }));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await h(authed(cookie, 'GET', 'me'))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('CHG-012 管理者の多要素認証（SEC-004）', () => {
  it('無効なら管理者もパスワードだけで session（従来どおり）', async () => {
    env = {};
    const res = await login('sec-admin');
    expect(res.status).toBe(200);
    expect(sessionOf(cookieOf(res))).toMatchObject({ userId: ids['admin'] });
    env = { ADMIN_MFA_ENABLED: 'true' };
  });

  it('有効なら管理者は確認待ち（session なし）。管理者以外は従来どおり', async () => {
    const res = await login('sec-admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const d = (await json(res)).data as Record<string, unknown>;
    valid('MfaChallenge', d);
    expect(d).toMatchObject({ mfaRequired: true, mfaEnrolled: false });
    expect((await login('sec-office')).headers.get('set-cookie')).toMatch(/session=/);
  });

  it('多要素認証の済んでいない管理者の session（有効にする前の session を含む）は使えない', async () => {
    env = {};
    const old = cookieOf(await login('sec-admin'));
    env = { ADMIN_MFA_ENABLED: 'true' };
    expect((await handleMeRequest(authed(old, 'GET', 'me'), { sessionSecret: SECRET, now: () => now, userGuard: guard() })).status).toBe(401);
  });

  it('登録: 確認待ち → 秘密鍵・QR コード → 認証アプリの確認コードで登録完了、session（mfa）と回復コード10個（一度だけ）', async () => {
    const ch = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    const setup = await json(await handleMfaSetup(post('auth/mfa/setup', { challenge: ch }), pub()));
    valid('MfaSetup', setup.data);
    const s = setup.data as { challenge: string; secret: string; otpauthUri: string; qrSvg: string };
    expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\/INSPEXOR%3Asec-admin\?secret=[A-Z2-7]+&issuer=INSPEXOR/);
    expect(s.qrSvg).toMatch(/^<svg/);
    // まだ保存しない
    expect((await userDoc(ids['admin'] as string)).mfa ?? null).toBeNull();
    // 誤ったコードは 401（失敗回数に数える）
    const bad = await handleMfaVerify(post('auth/mfa/verify', { challenge: s.challenge, code: '000000' }), pub());
    expect(bad.status).toBe(401);
    expect((await userDoc(ids['admin'] as string)).failedAttempts).toBe(1);
    const code = totp(base32Decode(s.secret), now.getTime());
    const ok = await handleMfaVerify(post('auth/mfa/verify', { challenge: s.challenge, code }), pub());
    expect(ok.status, await ok.clone().text()).toBe(200);
    const body = (await json(ok)).data as { recoveryCodes: string[]; roles: string[] };
    valid('Session', body);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    ids['recovery'] = JSON.stringify(body.recoveryCodes);
    const cookie = cookieOf(ok);
    expect(sessionOf(cookie)).toMatchObject({ mfa: true, userId: ids['admin'] });
    const u = await userDoc(ids['admin'] as string);
    expect(u.failedAttempts).toBe(0);
    expect(u.mfa?.recoveryHashes).toHaveLength(10);
    expect(JSON.stringify(u)).not.toContain(s.secret.replace(/ /g, ''));
    expect(JSON.stringify(u)).not.toContain(body.recoveryCodes[0]);
    expect((await handleMeRequest(authed(cookie, 'GET', 'me'), { sessionSecret: SECRET, now: () => now, userGuard: guard() })).status).toBe(200);
    // 同じ確認待ちで再登録はできない
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: s.challenge, code }), pub())).status).toBe(409);
    expect((await auditEventsFor(t.store, 'USER', ids['admin'] as string)).map((a) => a.action)).toContain('MFA_ENROLL');
  });

  it('登録済み: 確認コードで session。同じコード（同じ区間）の再利用は不可。期限切れ・改ざんした確認待ちは不可', async () => {
    now = new Date(now.getTime() + 60_000);
    const res = await json(await login('sec-admin'));
    expect(res.data).toMatchObject({ mfaRequired: true, mfaEnrolled: true });
    const ch = res.data?.['challenge'] as string;
    expect((await handleMfaSetup(post('auth/mfa/setup', { challenge: ch }), pub())).status).toBe(409);
    const code = await codeFor(ids['admin'] as string);
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code }), pub())).status).toBe(200);
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code }), pub())).status).toBe(401);
    const tampered = `${ch.slice(0, -2)}xx`;
    expect((await json(await handleMfaVerify(post('auth/mfa/verify', { challenge: tampered, code }), pub()))).error).toMatchObject({ code: 'AUTH_REQUIRED', challengeExpired: true });
    now = new Date(now.getTime() + 6 * 60_000);
    expect((await json(await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code: await codeFor(ids['admin'] as string) }), pub()))).error?.challengeExpired).toBe(true);
    // 確認コードと回復コードの両方・どちらも無しは 422
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch }), pub())).status).toBe(422);
  });

  it('回復コード: 1回だけ使える（監査に残り数）', async () => {
    now = new Date(now.getTime() + 60_000);
    const codes = JSON.parse(ids['recovery'] as string) as string[];
    const ch = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, recoveryCode: (codes[0] as string).toLowerCase() }), pub())).status).toBe(200);
    expect((await userDoc(ids['admin'] as string)).mfa?.recoveryHashes).toHaveLength(9);
    const ch2 = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch2, recoveryCode: codes[0] }), pub())).status).toBe(401);
    // 正しい確認コードで失敗回数は 0 に戻る
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch2, code: await codeFor(ids['admin'] as string) }), pub())).status).toBe(200);
    expect((await userDoc(ids['admin'] as string)).failedAttempts).toBe(0);
    const audit = (await auditEventsFor(t.store, 'USER', ids['admin'] as string)).find((a) => a.action === 'MFA_RECOVERY_USED');
    expect(audit?.afterData).toMatchObject({ remaining: 9 });
  });

  it('確認コードの誤りはパスワードの誤りと同じく数え、5回で 423（ロック中は正しいパスワードでも確認待ちを出さない）', async () => {
    now = new Date(now.getTime() + 60_000);
    let ch = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    for (let i = 0; i < 4; i += 1) expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code: '111111' }), pub())).status).toBe(401);
    // パスワードだけでは失敗回数は戻らない（確認コードを何度でも試せないように）
    ch = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    expect((await userDoc(ids['admin'] as string)).failedAttempts).toBe(4);
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code: '222222' }), pub())).status).toBe(401);
    expect((await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code: await codeFor(ids['admin'] as string) }), pub())).status).toBe(423);
    expect((await login('sec-admin')).status).toBe(423);
    now = new Date(now.getTime() + 16 * 60_000);
  });
});

describe('CHG-012 再認証（SEC-026）と管理者による解除', () => {
  let adminCookie = '';
  let admin2Cookie = '';

  it('再認証: パスワード＋確認コード（登録者）で session の認証時刻を更新。誤りは 422', async () => {
    const ch = (await json(await login('sec-admin'))).data?.['challenge'] as string;
    adminCookie = cookieOf(await handleMfaVerify(post('auth/mfa/verify', { challenge: ch, code: await codeFor(ids['admin'] as string) }), pub()));
    const h = mfaAccountHandlers(account());
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await json(await h.reauth(authed(adminCookie, 'POST', 'auth/reauth', { password: 'wrong-wrong-1' })))).error?.fields?.[0]?.path).toBe('/password');
    expect((await json(await h.reauth(authed(adminCookie, 'POST', 'auth/reauth', { password: PW })))).error?.fields?.[0]?.path).toBe('/code');
    const ok = await h.reauth(authed(adminCookie, 'POST', 'auth/reauth', { password: PW, code: await codeFor(ids['admin'] as string) }));
    expect(ok.status).toBe(200);
    const next = cookieOf(ok);
    expect(next).not.toBe(adminCookie);
    expect(sessionOf(next)).toMatchObject({ authAt: now.toISOString(), mfa: true, sessionId: sessionOf(adminCookie)?.sessionId });
    expect((ok.headers.get('set-cookie') ?? '').match(/__Secure-inspexor\.session=/g)).toHaveLength(1);
    adminCookie = next;
    // 管理者以外（多要素認証なし）はパスワードだけ
    const office = cookieOf(await login('sec-office'));
    expect((await h.reauth(authed(office, 'POST', 'auth/reauth', { password: PW }))).status).toBe(200);
  });

  it('回復コードの再発行は再認証から10分以内だけ。状態は本人が参照できる', async () => {
    const h = mfaAccountHandlers(account());
    const st = await json(await h.status(authed(adminCookie, 'GET', 'auth/mfa')));
    valid('MfaStatus', st.data);
    expect(st.data).toMatchObject({ required: true, enrolled: true, recoveryCodesRemaining: 9 });
    const r = await json(await h.regenerate(authed(adminCookie, 'POST', 'auth/mfa/recovery-codes', {})));
    expect((r.data?.['recoveryCodes'] as string[]).length).toBe(10);
    now = new Date(now.getTime() + 11 * 60_000);
    const late = await h.regenerate(authed(adminCookie, 'POST', 'auth/mfa/recovery-codes', {}));
    expect(late.status).toBe(403);
    expect((await json(late)).error).toMatchObject({ code: 'FORBIDDEN', reauthRequired: true });
  });

  it('管理者による解除（理由必須・自分は不可・再認証が必要）→ 対象の session は使えず、次のログインで登録し直す', async () => {
    // admin2 を登録
    const ch = (await json(await login('sec-admin2'))).data?.['challenge'] as string;
    const s = (await json(await handleMfaSetup(post('auth/mfa/setup', { challenge: ch }), pub()))).data as { challenge: string; secret: string };
    admin2Cookie = cookieOf(await handleMfaVerify(post('auth/mfa/verify', { challenge: s.challenge, code: totp(base32Decode(s.secret), now.getTime()) }), pub()));
    const users: UserRouteDeps = { service: () => new UserService(t.store, async (p) => `hashed:${p.length}`), api };
    const act = (cookie: string, id: string, body: Record<string, unknown>) => userActionHandlers(users).POST(authed(cookie, 'POST', `users/${id}/reset-mfa`, body));
    const v = (await userDoc(ids['admin'] as string)).version;
    // admin2 は登録直後（10分以内）なので再認証は不要
    expect((await act(admin2Cookie, ids['admin'] as string, { expectedVersion: v })).status).toBe(422);
    expect((await act(admin2Cookie, ids['admin2'] as string, { expectedVersion: (await userDoc(ids['admin2'] as string)).version, reason: '自分' })).status).toBe(422);
    const res = await act(admin2Cookie, ids['admin'] as string, { expectedVersion: v, reason: '端末の紛失' });
    expect(res.status).toBe(200);
    const d = (await json(res)).data as Record<string, unknown>;
    expect(d).toMatchObject({ mfaEnabled: false });
    valid('User', d);
    expect((await userDoc(ids['admin'] as string)).mfa ?? null).toBeNull();
    expect((await handleMeRequest(authed(adminCookie, 'GET', 'me'), { sessionSecret: SECRET, now: () => now, userGuard: guard() })).status).toBe(401);
    expect((await json(await login('sec-admin'))).data).toMatchObject({ mfaRequired: true, mfaEnrolled: false });
    const audit = (await auditEventsFor(t.store, 'USER', ids['admin'] as string)).find((a) => a.action === 'USER_RESET_MFA');
    expect(audit).toMatchObject({ actorId: ids['admin2'], reason: '端末の紛失' });
    // 11分後は再認証が必要（パスワード再設定も同じ）
    now = new Date(now.getTime() + 11 * 60_000);
    const late = await userActionHandlers(users).POST(authed(admin2Cookie, 'POST', `users/${ids['office']}/reset-password`, { expectedVersion: (await userDoc(ids['office'] as string)).version, password: 'new-password-123' }));
    expect(late.status).toBe(403);
    expect((await json(late)).error?.reauthRequired).toBe(true);
  });
});
