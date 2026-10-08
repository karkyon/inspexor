/**
 * G1 認可負試験（T-SEC-001〜004 / T-AUTH-001・003 の API入口部分 / T-CSRF-001）。
 * 実DBを使わず、AuditRepository は記録内容を検査できるfakeを使う。
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuditRecord, AuditRepository } from '@inspexor/application';
import type { RoleCode } from '@inspexor/domain';
import { createApiHandler, type ApiContext, type ApiHandlerDeps } from './api-handler';
import { issueSessionToken, type SessionPayload } from '../auth/session-token';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';
import { issueCsrfToken } from '../security/csrf';

const SECRET = 's'.repeat(32);
const NOW = new Date('2026-10-08T04:00:00.000Z');
const USER_ID = '22222222-2222-4222-8222-222222222222';
const IDEM_KEY = 'idem-key-0123456789';

function fakeAudit(): AuditRepository & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    append: vi.fn(async (record: AuditRecord) => {
      records.push(record);
      return '33333333-3333-4333-8333-333333333333';
    }),
  };
}

function deps(audit: AuditRepository = fakeAudit()): () => ApiHandlerDeps {
  return () => ({ sessionSecret: SECRET, now: () => NOW, auditRepository: audit, logError: () => undefined });
}

function session(roles: RoleCode[], overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'sess-1',
    userId: USER_ID,
    displayName: 'テスト',
    roles,
    issuedAt: '2026-10-08T03:55:00.000Z',
    lastActivityAt: '2026-10-08T03:55:00.000Z',
    ...overrides,
  };
}

interface RequestOptions {
  method?: string;
  roles?: RoleCode[] | null;
  csrf?: 'valid' | 'none' | 'wrong';
  idempotencyKey?: string | null;
  sessionOverrides?: Partial<SessionPayload>;
}

function request(opts: RequestOptions = {}): Request {
  const method = opts.method ?? 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.roles !== null && opts.roles !== undefined) {
    const payload = session(opts.roles, opts.sessionOverrides);
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${issueSessionToken(payload, SECRET)}`;
    const csrf = opts.csrf ?? 'valid';
    if (csrf === 'valid') headers['x-csrf-token'] = issueCsrfToken(payload.sessionId, SECRET);
    if (csrf === 'wrong') headers['x-csrf-token'] = issueCsrfToken('other-session', SECRET);
  }
  if (opts.idempotencyKey !== null && opts.idempotencyKey !== undefined) {
    headers['idempotency-key'] = opts.idempotencyKey;
  }
  return new Request('https://example.com/api/v1/x', { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) });
}

const okHandler = () => vi.fn(async (_ctx: ApiContext) => Response.json({ data: { ok: true }, meta: null }, { status: 200 }));

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('G1: 認証（API入口）', () => {
  it('未認証は401 AUTH_REQUIRED、handlerは呼ばれない', async () => {
    const h = okHandler();
    const res = await createApiHandler('createMaster', h, deps())(request({ roles: null }));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('AUTH_REQUIRED');
    expect(h).not.toHaveBeenCalled();
  });

  it('idle 30分超過のsessionは401', async () => {
    const res = await createApiHandler('getMe', okHandler(), deps())(
      request({ method: 'GET', roles: ['ADMIN'], sessionOverrides: { lastActivityAt: '2026-10-08T03:29:00.000Z' } }),
    );
    expect(res.status).toBe(401);
  });

  it('PUBLIC operation（login）は認証なしでhandlerに到達しactor=null', async () => {
    const h = okHandler();
    const res = await createApiHandler('login', h, deps())(request({ roles: null }));
    expect(res.status).toBe(200);
    expect(h.mock.calls[0]?.[0].actor).toBeNull();
  });
});

describe('G1: CSRF（T-CSRF-001、認証→CSRF→認可の順序）', () => {
  it('POSTでCSRFトークン無しは403 CSRF_INVALID', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(request({ roles: ['ADMIN'], csrf: 'none' }));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('CSRF_INVALID');
  });

  it('別session向けCSRFトークンは403 CSRF_INVALID', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(request({ roles: ['ADMIN'], csrf: 'wrong' }));
    expect(await code(res)).toBe('CSRF_INVALID');
  });

  it('GETはCSRF不要', async () => {
    const res = await createApiHandler('listRecords', okHandler(), deps())(request({ method: 'GET', roles: ['AUDITOR'], csrf: 'none' }));
    expect(res.status).toBe(200);
  });

  it('未認証かつCSRF無しは 401（認証が先）', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(request({ roles: null }));
    expect(res.status).toBe(401);
  });

  it('権限無しかつCSRF無しは 403 CSRF_INVALID（CSRFが認可より先）', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(request({ roles: ['FIELD'], csrf: 'none' }));
    expect(await code(res)).toBe('CSRF_INVALID');
  });
});

describe('G1: 認可負試験（T-SEC-001〜004）', () => {
  it.each([
    ['createMaster', ['FIELD']],
    ['createMaster', ['OFFICE']],
    ['createMaster', ['AUDITOR']],
    ['transitionRecord', ['FIELD']],
    ['transitionRecord', ['AUDITOR']],
    ['createBillingRun', ['AUDITOR']],
    ['getInvoice', ['FIELD']],
    ['createWorkReport', ['ADMIN']],
  ] as const)('%s を %j は 403 FORBIDDEN、handler未実行、拒否をauditに記録', async (op, roles) => {
    const audit = fakeAudit();
    const h = okHandler();
    const res = await createApiHandler(op, h, deps(audit))(
      request({ method: op.startsWith('list') || op.startsWith('get') ? 'GET' : 'POST', roles: [...roles], idempotencyKey: IDEM_KEY }),
    );
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('FORBIDDEN');
    expect(h).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ actorId: USER_ID, action: 'AUTHZ_DENIED', targetType: 'USER', targetId: USER_ID });
    expect(audit.records[0]?.afterData).toMatchObject({ operationId: op });
  });

  it('audit書込失敗でも403を返す（拒否は維持）', async () => {
    const failing: AuditRepository = { append: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const res = await createApiHandler('createMaster', okHandler(), deps(failing))(request({ roles: ['FIELD'] }));
    expect(res.status).toBe(403);
  });

  it('許可ロールはhandlerに到達しactor/rolesが渡る', async () => {
    const h = okHandler();
    const res = await createApiHandler('createMaster', h, deps())(request({ roles: ['ADMIN'] }));
    expect(res.status).toBe(200);
    expect(h.mock.calls[0]?.[0].actor).toMatchObject({ userId: USER_ID, roles: ['ADMIN'] });
  });

  it('owner/OFFICE型をFIELDが呼ぶと ownerCheckRequired=true でhandlerに委譲', async () => {
    const h = okHandler();
    await createApiHandler('updateWorkReport', h, deps())(request({ method: 'PATCH', roles: ['FIELD'] }));
    expect(h.mock.calls[0]?.[0].ownerCheckRequired).toBe(true);
  });

  it('セッション内の未知ロール文字列は無視される（権限昇格しない）', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(
      request({ roles: ['SUPERUSER' as RoleCode] }),
    );
    expect(res.status).toBe(403);
  });
});

describe('G1: Idempotency-Key（T-IDEM-001 入口）', () => {
  it('idempotent operationでヘッダ無しは422', async () => {
    const res = await createApiHandler('createBillingRun', okHandler(), deps())(request({ roles: ['OFFICE'] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: Array<{ path: string }> } };
    expect(body.error.fields[0]?.path).toBe('/headers/Idempotency-Key');
  });

  it('15文字は422、16文字は通過、101文字は422', async () => {
    const run = (key: string) => createApiHandler('createBillingRun', okHandler(), deps())(request({ roles: ['OFFICE'], idempotencyKey: key }));
    expect((await run('a'.repeat(15))).status).toBe(422);
    expect((await run('a'.repeat(16))).status).toBe(200);
    expect((await run('a'.repeat(100))).status).toBe(200);
    expect((await run('a'.repeat(101))).status).toBe(422);
  });

  it('handlerにidempotencyKeyが渡る、非idempotent opはnull', async () => {
    const h1 = okHandler();
    await createApiHandler('createBillingRun', h1, deps())(request({ roles: ['OFFICE'], idempotencyKey: IDEM_KEY }));
    expect(h1.mock.calls[0]?.[0].idempotencyKey).toBe(IDEM_KEY);
    const h2 = okHandler();
    await createApiHandler('createMaster', h2, deps())(request({ roles: ['ADMIN'], idempotencyKey: IDEM_KEY }));
    expect(h2.mock.calls[0]?.[0].idempotencyKey).toBeNull();
  });
});

describe('G1: エラー最小化・session延長', () => {
  it('handler例外は500 INTERNAL_ERROR、内部メッセージを返さない（SEC-010）', async () => {
    const res = await createApiHandler(
      'createMaster',
      async () => {
        throw new Error('SELECT * FROM secret_table failed');
      },
      deps(),
    )(request({ roles: ['ADMIN'] }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain('secret_table');
  });

  it('成功応答でsession cookieを再発行し、correlationIdヘッダを付与', async () => {
    const res = await createApiHandler('createMaster', okHandler(), deps())(request({ roles: ['ADMIN'] }));
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('4xx応答ではsession cookieを再発行しない', async () => {
    const res = await createApiHandler(
      'createMaster',
      async () => Response.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 422 }),
      deps(),
    )(request({ roles: ['ADMIN'] }));
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
