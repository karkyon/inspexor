import { describe, it, expect, vi } from 'vitest';
import { login, type UserRecord, type UserRepository, type PasswordHasher } from './login';

const NOW = new Date('2026-10-07T00:00:00Z');

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    loginId: 'taro',
    passwordHash: 'hashed',
    displayName: '太郎',
    status: 'ACTIVE',
    roles: ['FIELD'],
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function makeRepo(user: UserRecord | null): UserRepository & { updateLockoutState: ReturnType<typeof vi.fn> } {
  return {
    findByLoginId: vi.fn().mockResolvedValue(user),
    updateLockoutState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('login use-case: API-001/SEC-002/SEC-003準拠', () => {
  it('正しいID/passwordで成功', async () => {
    const user = makeUser();
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(true) };
    const result = await login({ loginId: 'taro', password: 'correct' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: true, userId: 'user-1', displayName: '太郎', roles: ['FIELD'] });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 0, lockedUntil: null });
  });

  it('存在しないloginIdはAUTH_REQUIRED（列挙対策）', async () => {
    const repo = makeRepo(null);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'ghost', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
  });

  it('INACTIVEユーザーはAUTH_REQUIRED', async () => {
    const user = makeUser({ status: 'INACTIVE' });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'taro', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
  });

  it('ロック中はACCOUNT_LOCKED（パスワード検証はしない）', async () => {
    const user = makeUser({ failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:10:00Z') });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'taro', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'ACCOUNT_LOCKED' });
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('誤passwordはfailedAttemptsを加算してAUTH_REQUIRED', async () => {
    const user = makeUser({ failedAttempts: 3 });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(false) };
    const result = await login({ loginId: 'taro', password: 'wrong' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 4, lockedUntil: null });
  });

  it('5回目の誤passwordでlockedUntilが設定される', async () => {
    const user = makeUser({ failedAttempts: 4 });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(false) };
    await login({ loginId: 'taro', password: 'wrong' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:15:00Z') });
  });

  it('CHG-012: deferLockoutReset が true なら成功でも失敗回数を戻さない（多要素認証の確認後に戻す）', async () => {
    const user = makeUser({ failedAttempts: 2, roles: ['ADMIN'] });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(true) };
    const result = await login({ loginId: 'taro', password: 'correct' }, { userRepository: repo, passwordHasher: hasher, now: NOW, deferLockoutReset: (u) => u.roles.includes('ADMIN') });
    expect(result.ok).toBe(true);
    expect(repo.updateLockoutState).not.toHaveBeenCalled();
  });
});
