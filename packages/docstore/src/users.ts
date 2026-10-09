/**
 * users（PostgreSQL の users＋user_roles）。ログインID は uniqueKeys（kind 'login'）で一意にする。
 */
import { randomUUID } from 'node:crypto';
import type { LockoutState } from '@inspexor/domain';
import type { UserRecord, UserRepository, UserStatus } from '@inspexor/application';
import { C, claimUnique, readUniqueOwner } from './repos';
import { DocStoreError, type DocStore } from './types';

export interface UserDoc {
  readonly loginId: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly roles: readonly string[];
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class DocUserRepository implements UserRepository {
  constructor(
    private readonly store: DocStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findByLoginId(loginId: string): Promise<UserRecord | null> {
    const rows = await this.store.query<UserDoc>(C.users, { where: [{ field: 'loginId', op: '==', value: loginId }], limit: 2 });
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      loginId: row.data.loginId,
      passwordHash: row.data.passwordHash,
      displayName: row.data.displayName,
      status: row.data.status,
      roles: [...row.data.roles],
      failedAttempts: row.data.failedAttempts,
      lockedUntil: row.data.lockedUntil,
    };
  }

  async updateLockoutState(userId: string, state: LockoutState): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      tx.update(`${C.users}/${userId}`, { failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil, updatedAt: this.now() });
    });
  }
}

export interface NewUser {
  readonly loginId: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly id?: string;
}

/** ユーザー作成（ログインID 重複は null）。seed・試験・将来の管理画面で使う */
export async function createUser(store: DocStore, input: NewUser, now: Date): Promise<string | null> {
  const id = input.id ?? randomUUID();
  try {
    return await store.runTransaction(async (tx) => {
      if ((await readUniqueOwner(tx, 'login', '-', input.loginId)) !== null) return null;
      const doc: UserDoc = {
        loginId: input.loginId,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        status: 'ACTIVE',
        roles: [...input.roles],
        failedAttempts: 0,
        lockedUntil: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      claimUnique(tx, 'login', '-', input.loginId, id);
      tx.create(`${C.users}/${id}`, doc);
      return id;
    });
  } catch (error) {
    if (error instanceof DocStoreError && error.code === 'ALREADY_EXISTS') return null;
    throw error;
  }
}

export async function findUserById(store: DocStore, id: string): Promise<(UserDoc & { id: string }) | null> {
  const d = await store.get<UserDoc>(`${C.users}/${id}`);
  return d === null ? null : { ...d, id };
}
