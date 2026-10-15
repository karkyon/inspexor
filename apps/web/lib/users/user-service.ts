/**
 * CHG-008 利用者管理（業務要件 §2 RBAC「master/user: ADMIN=CRUD、OFFICE/AUDITOR=R」）。
 *   一覧・作成・表示名とロールの変更・無効化/有効化・パスワード再設定・ロック解除
 *   ログインID は変更しない（uniqueKeys 'login' で一意）。パスワードは Argon2id で保存し、応答・監査に出さない
 *   無効化・ロール変更・パスワード再設定は authChangedAt を更新し、それ以前のセッションを使えなくする（user-guard）
 *   自分自身の無効化・ADMIN 外し、有効な ADMIN が 0 人になる変更は不可（管理不能を防ぐ）
 *   CHG-012: 多要素認証の解除（reset-mfa、理由必須、自分以外）。次のログインで登録し直す。解除・パスワード再設定は再認証が必要（handler）
 */
import { randomUUID } from 'node:crypto';
import { checkLockout } from '@inspexor/domain';
import { appendAudit, C, claimUnique, readUniqueOwner, type DocStore, type DocTransaction, type UserDoc } from '@inspexor/docstore';
import { invalidateUserGuard } from '../auth/user-guard';

export const ROLE_CODES = ['FIELD', 'OFFICE', 'ADMIN', 'AUDITOR'] as const;
export type Role = (typeof ROLE_CODES)[number];
export type UserAction = 'deactivate' | 'activate' | 'reset-password' | 'unlock' | 'reset-mfa';

export class UserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: ReadonlyArray<{ path: string; code: string; message: string }> = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface UserView {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly locked: boolean;
  /** CHG-012 多要素認証を登録済みか */
  readonly mfaEnabled: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserContext {
  readonly actorId: string;
  readonly correlationId: string;
  readonly now: Date;
}

export interface PasswordHashFn {
  (plain: string): Promise<string>;
}

function view(id: string, d: UserDoc, now: Date): UserView {
  return {
    id,
    loginId: d.loginId,
    displayName: d.displayName,
    roles: [...d.roles],
    status: d.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
    locked: checkLockout({ failedAttempts: d.failedAttempts, lockedUntil: d.lockedUntil }, now).locked,
    mfaEnabled: (d.mfa ?? null) !== null,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

const path = (id: string): string => `${C.users}/${id}`;
const notFound = (): UserError => new UserError(404, 'VALIDATION_ERROR', '利用者が見つかりません。', [{ path: '/id', code: 'not_found', message: '利用者が見つかりません。' }]);

export class UserService {
  constructor(
    private readonly store: DocStore,
    private readonly hash: PasswordHashFn,
  ) {}

  async list(now: Date): Promise<UserView[]> {
    const rows = await this.store.query<UserDoc>(C.users);
    return rows.map((r) => view(r.id, r.data, now)).sort((a, b) => (a.loginId < b.loginId ? -1 : a.loginId > b.loginId ? 1 : 0));
  }

  async get(id: string, now: Date): Promise<UserView> {
    const d = await this.store.get<UserDoc>(path(id));
    if (d === null) throw notFound();
    return view(id, d, now);
  }

  async create(input: { loginId: string; displayName: string; roles: Role[]; password: string }, ctx: UserContext): Promise<UserView> {
    const passwordHash = await this.hash(input.password);
    const id = randomUUID();
    return this.store.runTransaction(async (tx) => {
      if ((await readUniqueOwner(tx, 'login', '-', input.loginId)) !== null) {
        throw new UserError(422, 'VALIDATION_ERROR', '既に登録されています。', [{ path: '/loginId', code: 'duplicate', message: 'このログインIDは既に使われています。' }]);
      }
      const doc: UserDoc = {
        loginId: input.loginId,
        passwordHash,
        displayName: input.displayName,
        status: 'ACTIVE',
        roles: [...input.roles],
        failedAttempts: 0,
        lockedUntil: null,
        version: 1,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        authChangedAt: null,
      };
      claimUnique(tx, 'login', '-', input.loginId, id);
      tx.create(path(id), doc);
      appendAudit(tx, { actorId: ctx.actorId, action: 'USER_CREATE', targetType: 'USER', targetId: id, afterData: { loginId: input.loginId, displayName: input.displayName, roles: input.roles }, correlationId: ctx.correlationId, occurredAt: ctx.now }, ctx.now);
      return view(id, doc, ctx.now);
    });
  }

  async update(id: string, input: { expectedVersion: number; displayName: string; roles: Role[] }, ctx: UserContext): Promise<UserView> {
    const result = await this.store.runTransaction(async (tx) => {
      const cur = await this.readForUpdate(tx, id, input.expectedVersion);
      const rolesChanged = [...cur.roles].sort().join(',') !== [...input.roles].sort().join(',');
      if (rolesChanged && id === ctx.actorId && !input.roles.includes('ADMIN')) {
        throw new UserError(422, 'VALIDATION_ERROR', '自分自身の管理者ロールは外せません。', [{ path: '/roles', code: 'self', message: '自分自身の管理者ロールは外せません。' }]);
      }
      if (rolesChanged && cur.roles.includes('ADMIN') && !input.roles.includes('ADMIN') && cur.status === 'ACTIVE') await this.ensureOtherAdmin(tx, id);
      const next = {
        displayName: input.displayName,
        roles: [...input.roles],
        version: cur.version + 1,
        updatedAt: ctx.now,
        ...(rolesChanged ? { authChangedAt: ctx.now } : {}),
      };
      tx.update(path(id), next);
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: 'USER_UPDATE',
          targetType: 'USER',
          targetId: id,
          beforeData: { displayName: cur.displayName, roles: cur.roles, version: cur.version },
          afterData: { displayName: input.displayName, roles: input.roles, version: next.version },
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return view(id, { ...cur, ...next }, ctx.now);
    });
    invalidateUserGuard(id);
    return result;
  }

  async act(id: string, action: UserAction, input: { expectedVersion: number; reason: string | null; password?: string | undefined }, ctx: UserContext): Promise<UserView> {
    const passwordHash = action === 'reset-password' ? await this.hash(input.password ?? '') : null;
    const result = await this.store.runTransaction(async (tx) => {
      const cur = await this.readForUpdate(tx, id, input.expectedVersion);
      let patch: Partial<UserDoc>;
      switch (action) {
        case 'deactivate':
          if (id === ctx.actorId) throw new UserError(422, 'VALIDATION_ERROR', '自分自身は無効化できません。');
          if (cur.status !== 'ACTIVE') throw new UserError(409, 'STATE_CONFLICT', '既に無効です。', [], { currentVersion: cur.version });
          if (cur.roles.includes('ADMIN')) await this.ensureOtherAdmin(tx, id);
          patch = { status: 'INACTIVE', authChangedAt: ctx.now };
          break;
        case 'activate':
          if (cur.status === 'ACTIVE') throw new UserError(409, 'STATE_CONFLICT', '既に有効です。', [], { currentVersion: cur.version });
          patch = { status: 'ACTIVE', failedAttempts: 0, lockedUntil: null };
          break;
        case 'reset-password':
          patch = { passwordHash: passwordHash as string, failedAttempts: 0, lockedUntil: null, authChangedAt: ctx.now };
          break;
        case 'unlock':
          patch = { failedAttempts: 0, lockedUntil: null };
          break;
        case 'reset-mfa':
          if (id === ctx.actorId) throw new UserError(422, 'VALIDATION_ERROR', '自分自身の多要素認証は解除できません（回復コードを使うか、他の管理者に依頼してください）。');
          if ((cur.mfa ?? null) === null) throw new UserError(409, 'STATE_CONFLICT', '多要素認証は登録されていません。', [], { currentVersion: cur.version });
          // 解除後のログインで登録し直す。それより前の session は使えない
          patch = { mfa: null, authChangedAt: ctx.now };
          break;
      }
      const version = cur.version + 1;
      tx.update(path(id), { ...patch, version, updatedAt: ctx.now });
      appendAudit(
        tx,
        {
          actorId: ctx.actorId,
          action: `USER_${action.replace('-', '_').toUpperCase()}`,
          targetType: 'USER',
          targetId: id,
          beforeData: { status: cur.status, locked: checkLockout({ failedAttempts: cur.failedAttempts, lockedUntil: cur.lockedUntil }, ctx.now).locked, version: cur.version },
          afterData: { status: patch.status ?? cur.status, version, ...(action === 'reset-mfa' ? { mfaEnabled: false } : {}) },
          ...(input.reason !== null ? { reason: input.reason } : {}),
          correlationId: ctx.correlationId,
          occurredAt: ctx.now,
        },
        ctx.now,
      );
      return view(id, { ...cur, ...patch, version, updatedAt: ctx.now } as UserDoc, ctx.now);
    });
    invalidateUserGuard(id);
    return result;
  }

  private async readForUpdate(tx: DocTransaction, id: string, expectedVersion: number): Promise<UserDoc> {
    const cur = await tx.get<UserDoc>(path(id));
    if (cur === null) throw notFound();
    if (cur.version !== expectedVersion) {
      throw new UserError(409, 'VERSION_CONFLICT', '他の利用者により更新されています。再読込してください。', [], { currentVersion: cur.version });
    }
    return cur;
  }

  /** 対象以外に有効な ADMIN がいること（管理不能を防ぐ） */
  private async ensureOtherAdmin(tx: DocTransaction, id: string): Promise<void> {
    const admins = await tx.query<UserDoc>(C.users, { where: [{ field: 'roles', op: 'array-contains', value: 'ADMIN' }] });
    if (!admins.some((a) => a.id !== id && a.data.status === 'ACTIVE')) {
      throw new UserError(422, 'VALIDATION_ERROR', '有効な管理者が1人もいなくなるため変更できません。', [{ path: '/roles', code: 'last_admin', message: '有効な管理者が1人もいなくなります。' }]);
    }
  }
}
