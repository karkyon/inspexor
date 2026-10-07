import { describe, it, expect, vi } from 'vitest';
import { handleLoginRequest } from './login-handler';
import { verifySessionToken } from './session-token';
import type { UserRecord, UserRepository, PasswordHasher } from '@inspexor/application';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-07T09:00:00.000Z');

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u-1',
    loginId: 'tanaka',
    passwordHash: '$argon2id$dummy',
    displayName: '田中太郎',
    status: 'ACTIVE',
    roles: ['OFFICE'],
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request('https://example.com/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleLoginRequest', () => {
  it('正しい認証情報で200 + Set-Cookie(session) + csrfTokenを返す', async () => {
    const userRepository: UserRepository = {
      findByLoginId: vi.fn().mockResolvedValue(makeUser()),
      updateLockoutState: vi.fn().mockResolvedValue(undefined),
    };
    const passwordHasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(true) };

    const response = await handleLoginRequest(makeRequest({ loginId: 'tanaka', password: 'correct' }), {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data.userId).toBe('u-1');
    expect(body.data.displayName).toBe('田中太郎');
    expect(body.data.roles).toEqual(['OFFICE']);
    expect(typeof body.data.csrfToken).toBe('string');

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('inspexor_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const token = setCookie?.split('inspexor_session=')[1]?.split(';')[0] ?? '';
    const payload = verifySessionToken(token, SECRET);
    expect(payload?.userId).toBe('u-1');
    expect(userRepository.updateLockoutState).toHaveBeenCalledWith('u-1', { failedAttempts: 0, lockedUntil: null });
  });

  it('誤ったpasswordは401 AUTH_REQUIRED（詳細理由は返さない）', async () => {
    const userRepository: UserRepository = {
      findByLoginId: vi.fn().mockResolvedValue(makeUser()),
      updateLockoutState: vi.fn().mockResolvedValue(undefined),
    };
    const passwordHasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(false) };

    const response = await handleLoginRequest(makeRequest({ loginId: 'tanaka', password: 'wrong' }), {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('AUTH_REQUIRED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('ロック中は423 ACCOUNT_LOCKED', async () => {
    const userRepository: UserRepository = {
      findByLoginId: vi
        .fn()
        .mockResolvedValue(makeUser({ failedAttempts: 5, lockedUntil: new Date('2026-10-07T09:10:00.000Z') })),
      updateLockoutState: vi.fn().mockResolvedValue(undefined),
    };
    const passwordHasher: PasswordHasher = { verify: vi.fn() };

    const response = await handleLoginRequest(makeRequest({ loginId: 'tanaka', password: 'x' }), {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(423);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('存在しないloginIdも401 AUTH_REQUIRED（存在秘匿、同じ応答形）', async () => {
    const userRepository: UserRepository = {
      findByLoginId: vi.fn().mockResolvedValue(null),
      updateLockoutState: vi.fn().mockResolvedValue(undefined),
    };
    const passwordHasher: PasswordHasher = { verify: vi.fn() };

    const response = await handleLoginRequest(makeRequest({ loginId: 'nobody', password: 'x' }), {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('AUTH_REQUIRED');
  });

  it('未知fieldは422 VALIDATION_ERROR', async () => {
    const userRepository: UserRepository = { findByLoginId: vi.fn(), updateLockoutState: vi.fn() };
    const passwordHasher: PasswordHasher = { verify: vi.fn() };

    const response = await handleLoginRequest(
      makeRequest({ loginId: 'tanaka', password: 'x', extra: 'not-allowed' }),
      { userRepository, passwordHasher, sessionSecret: SECRET, now: () => NOW },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(userRepository.findByLoginId).not.toHaveBeenCalled();
  });

  it('不正なJSON bodyは400 VALIDATION_ERROR', async () => {
    const request = new Request('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const userRepository: UserRepository = { findByLoginId: vi.fn(), updateLockoutState: vi.fn() };
    const passwordHasher: PasswordHasher = { verify: vi.fn() };

    const response = await handleLoginRequest(request, {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(400);
  });

  it('loginId空文字は422 VALIDATION_ERROR', async () => {
    const userRepository: UserRepository = { findByLoginId: vi.fn(), updateLockoutState: vi.fn() };
    const passwordHasher: PasswordHasher = { verify: vi.fn() };

    const response = await handleLoginRequest(makeRequest({ loginId: '', password: 'x' }), {
      userRepository,
      passwordHasher,
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(422);
  });
});
