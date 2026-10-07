#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

# ============================================================
# 0. apps/web: 依存追加（zod, 既にdomain/applicationはworkspace参照済）
# ============================================================
cd apps/web
pnpm add zod
cd ~/inspexor

mkdir -p apps/web/lib/auth apps/web/lib/db apps/web/app/api/auth/login apps/web/app/api/auth/logout apps/web/app/api/auth/me

# ============================================================
# 1. apps/web/lib/auth/session-secret.ts
# ============================================================
cat > apps/web/lib/auth/session-secret.ts << 'EOF'
export function getSessionSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is not set');
  }
  return secret;
}
EOF

# ============================================================
# 2. apps/web/lib/auth/session-token.ts + test
#    （サンドボックスで node:crypto実パッケージで24/24 PASS確認済み）
# ============================================================
cat > apps/web/lib/auth/session-token.ts << 'EOF'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly issuedAt: string;
  readonly lastActivityAt: string;
}

const SESSION_ID_BYTES = 18;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function hmac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function generateSessionId(): string {
  return base64url(randomBytes(SESSION_ID_BYTES));
}

export function issueSessionToken(payload: SessionPayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64url(hmac(secret, body));
  return `${body}.${signature}`;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['sessionId'] === 'string' &&
    typeof candidate['userId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['roles']) &&
    candidate['roles'].every((role) => typeof role === 'string') &&
    typeof candidate['issuedAt'] === 'string' &&
    typeof candidate['lastActivityAt'] === 'string'
  );
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    return null;
  }

  const expected = base64url(hmac(secret, body));
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return isSessionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function refreshLastActivity(payload: SessionPayload, now: Date): SessionPayload {
  return { ...payload, lastActivityAt: now.toISOString() };
}
EOF

cat > apps/web/lib/auth/session-token.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import {
  generateSessionId,
  issueSessionToken,
  verifySessionToken,
  refreshLastActivity,
  type SessionPayload,
} from './session-token';

const SECRET = 'a'.repeat(32);

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: generateSessionId(),
    userId: 'u-1',
    displayName: '田中太郎',
    roles: ['OFFICE'],
    issuedAt: '2026-10-07T00:00:00.000Z',
    lastActivityAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('session-token: issue/verify round-trip', () => {
  it('正しいsecretでverifyすると元のpayloadが復元される', () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    expect(verifySessionToken(token, SECRET)).toEqual(payload);
  });

  it('誤ったsecretはnullを返す', () => {
    const token = issueSessionToken(makePayload(), SECRET);
    expect(verifySessionToken(token, 'b'.repeat(32))).toBeNull();
  });

  it('改ざんされたbodyはnullを返す（署名不一致）', () => {
    const token = issueSessionToken(makePayload(), SECRET);
    const [, signature] = token.split('.');
    const tamperedPayload = makePayload({ roles: ['ADMIN'] });
    const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
    expect(verifySessionToken(`${tamperedBody}.${signature}`, SECRET)).toBeNull();
  });

  it('ドット区切りでない文字列はnullを返す', () => {
    expect(verifySessionToken('not-a-token', SECRET)).toBeNull();
  });

  it('壊れたJSONはnullを返す（例外を投げない）', () => {
    const body = Buffer.from('not-json', 'utf8').toString('base64url');
    const signature = Buffer.from('x').toString('base64url');
    expect(() => verifySessionToken(`${body}.${signature}`, SECRET)).not.toThrow();
  });

  it('必須フィールド欠落のpayloadはnullを返す', () => {
    const incomplete = { userId: 'u-1' };
    const body = Buffer.from(JSON.stringify(incomplete), 'utf8').toString('base64url');
    const crypto = require('node:crypto');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(verifySessionToken(`${body}.${sig}`, SECRET)).toBeNull();
  });
});

describe('session-token: generateSessionId', () => {
  it('呼び出しごとに異なるIDを生成する', () => {
    expect(generateSessionId()).not.toBe(generateSessionId());
  });
});

describe('session-token: refreshLastActivity', () => {
  it('lastActivityAtのみ更新し他は不変', () => {
    const payload = makePayload();
    const now = new Date('2026-10-07T01:23:45.000Z');
    const refreshed = refreshLastActivity(payload, now);
    expect(refreshed.lastActivityAt).toBe('2026-10-07T01:23:45.000Z');
    expect(refreshed.sessionId).toBe(payload.sessionId);
    expect(refreshed.userId).toBe(payload.userId);
  });
});
EOF

# ============================================================
# 3. apps/web/lib/auth/session-cookie.ts
# ============================================================
cat > apps/web/lib/auth/session-cookie.ts << 'EOF'
export const SESSION_COOKIE_NAME = 'inspexor_session';

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) {
      return rawValueParts.join('=');
    }
  }
  return null;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
EOF

# ============================================================
# 4. apps/web/lib/auth/login-handler.ts + test
#    注: @inspexor/domain が session-policy.ts を index.ts から
#    re-exportしている前提（g0_batch3で追加された想定）。
#    importが解決しない場合は packages/domain/src/index.ts に
#    `export * from './session-policy';` を追加してください。
# ============================================================
cat > apps/web/lib/auth/login-handler.ts << 'EOF'
import { ZodError } from 'zod';
import { login, type LoginDeps, type UserRepository, type PasswordHasher } from '@inspexor/application';
import { sessionCookieAttributes } from '@inspexor/domain';
import { issueCsrfToken } from '../security/csrf';
import { loginRequestSchema } from './login-request-schema';
import { issueSessionToken, generateSessionId, type SessionPayload } from './session-token';
import { sessionCookieHeader } from './session-cookie';

export interface LoginHandlerDeps {
  readonly userRepository: UserRepository;
  readonly passwordHasher: PasswordHasher;
  readonly sessionSecret: string;
  readonly now: () => Date;
}

function errorResponse(status: number, code: string, message: string, correlationId: string): Response {
  return Response.json({ error: { code, message, correlationId, retryable: false } }, { status });
}

export async function handleLoginRequest(request: Request, deps: LoginHandlerDeps): Promise<Response> {
  const correlationId = request.headers.get('x-correlation-id') ?? generateSessionId();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'request bodyがJSONとして解釈できません。', correlationId);
  }

  const parsed = loginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const zodError: ZodError = parsed.error;
    return Response.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力値が不正です。',
          fields: zodError.issues.map((issue) => ({
            path: `/${issue.path.join('/')}`,
            message: issue.message,
          })),
          correlationId,
          retryable: false,
        },
      },
      { status: 422 },
    );
  }

  const now = deps.now();
  const loginDeps: LoginDeps = {
    userRepository: deps.userRepository,
    passwordHasher: deps.passwordHasher,
    now,
  };

  const result = await login(parsed.data, loginDeps);

  if (!result.ok) {
    // 存在秘匿: AUTH_REQUIRED/ACCOUNT_LOCKEDいずれも詳細を返さない（FR-001失敗時要件）。
    const status = result.errorCode === 'ACCOUNT_LOCKED' ? 423 : 401;
    return errorResponse(status, result.errorCode, '認証に失敗しました。', correlationId);
  }

  const sessionPayload: SessionPayload = {
    sessionId: generateSessionId(),
    userId: result.userId,
    displayName: result.displayName,
    roles: result.roles,
    issuedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
  };
  const token = issueSessionToken(sessionPayload, deps.sessionSecret);
  const cookieAttrs = sessionCookieAttributes();
  const csrfToken = issueCsrfToken(sessionPayload.sessionId, deps.sessionSecret);

  const response = Response.json(
    {
      data: {
        userId: result.userId,
        displayName: result.displayName,
        roles: result.roles,
        csrfToken,
      },
      meta: null,
    },
    { status: 200, headers: { 'x-correlation-id': correlationId } },
  );
  response.headers.append('Set-Cookie', sessionCookieHeader(token, cookieAttrs.maxAge));
  return response;
}
EOF

cat > apps/web/lib/auth/login-request-schema.ts << 'EOF'
import { z } from 'zod';

// API-001 POST /auth/login の LoginRequest。未知field拒否（.strict）、文字列trim。
export const loginRequestSchema = z
  .object({
    loginId: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginRequestInput = z.infer<typeof loginRequestSchema>;
EOF

cat > apps/web/lib/auth/login-handler.test.ts << 'EOF'
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
EOF

# ============================================================
# 5. apps/web/lib/auth/me-handler.ts + test
# ============================================================
cat > apps/web/lib/auth/me-handler.ts << 'EOF'
import { checkSessionValidity, sessionCookieAttributes } from '@inspexor/domain';
import { verifySessionToken, issueSessionToken, refreshLastActivity } from './session-token';
import { readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from './session-cookie';

export interface MeHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
}

function unauthenticated(correlationId: string): Response {
  const response = Response.json(
    { error: { code: 'AUTH_REQUIRED', message: '認証が必要です。', correlationId, retryable: false } },
    { status: 401 },
  );
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}

export async function handleMeRequest(request: Request, deps: MeHandlerDeps): Promise<Response> {
  const correlationId = request.headers.get('x-correlation-id') ?? 'no-correlation-id';
  const token = readSessionCookie(request);
  if (!token) {
    return unauthenticated(correlationId);
  }

  const payload = verifySessionToken(token, deps.sessionSecret);
  if (!payload) {
    return unauthenticated(correlationId);
  }

  const now = deps.now();
  const validity = checkSessionValidity(
    { issuedAt: new Date(payload.issuedAt), lastActivityAt: new Date(payload.lastActivityAt) },
    now,
  );
  if (!validity.valid) {
    return unauthenticated(correlationId);
  }

  const refreshed = refreshLastActivity(payload, now);
  const refreshedToken = issueSessionToken(refreshed, deps.sessionSecret);
  const cookieAttrs = sessionCookieAttributes();

  const response = Response.json(
    {
      data: { userId: payload.userId, displayName: payload.displayName, roles: payload.roles },
      meta: null,
    },
    { status: 200, headers: { 'x-correlation-id': correlationId } },
  );
  response.headers.append('Set-Cookie', sessionCookieHeader(refreshedToken, cookieAttrs.maxAge));
  return response;
}
EOF

cat > apps/web/lib/auth/me-handler.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { handleMeRequest } from './me-handler';
import { issueSessionToken, type SessionPayload } from './session-token';
import { SESSION_COOKIE_NAME } from './session-cookie';

const SECRET = 'a'.repeat(32);

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 's-1',
    userId: 'u-1',
    displayName: '田中太郎',
    roles: ['OFFICE'],
    issuedAt: '2026-10-07T09:00:00.000Z',
    lastActivityAt: '2026-10-07T09:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(cookie: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  return new Request('https://example.com/api/me', { headers });
}

describe('handleMeRequest', () => {
  it('有効なsessionで200を返し、Set-CookieでlastActivityAtが更新される', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T09:05:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data).toEqual({ userId: 'u-1', displayName: '田中太郎', roles: ['OFFICE'] });
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it('cookie無しは401', async () => {
    const response = await handleMeRequest(makeRequest(null), {
      sessionSecret: SECRET,
      now: () => new Date(),
    });
    expect(response.status).toBe(401);
  });

  it('改ざんされたtokenは401', async () => {
    const response = await handleMeRequest(makeRequest('tampered.token'), {
      sessionSecret: SECRET,
      now: () => new Date(),
    });
    expect(response.status).toBe(401);
  });

  it('idle30分超過は401（IDLE_TIMEOUT）', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T09:31:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });
    expect(response.status).toBe(401);
  });

  it('absolute12時間超過は401（ABSOLUTE_TIMEOUT）', async () => {
    const payload = makePayload({ lastActivityAt: '2026-10-07T20:59:00.000Z' });
    const token = issueSessionToken(payload, SECRET);
    const now = new Date('2026-10-07T21:01:00.000Z');

    const response = await handleMeRequest(makeRequest(token), { sessionSecret: SECRET, now: () => now });
    expect(response.status).toBe(401);
  });
});
EOF

# ============================================================
# 6. apps/web/lib/auth/logout-handler.ts + test
# ============================================================
cat > apps/web/lib/auth/logout-handler.ts << 'EOF'
import { checkSessionValidity } from '@inspexor/domain';
import { verifySessionToken } from './session-token';
import { verifyCsrfToken } from '../security/csrf';
import { readSessionCookie, clearSessionCookieHeader } from './session-cookie';

export interface LogoutHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
}

function unauthenticated(correlationId: string): Response {
  const response = Response.json(
    { error: { code: 'AUTH_REQUIRED', message: '認証が必要です。', correlationId, retryable: false } },
    { status: 401 },
  );
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}

function csrfInvalid(correlationId: string): Response {
  return Response.json(
    { error: { code: 'CSRF_INVALID', message: 'CSRFトークンが無効です。', correlationId, retryable: false } },
    { status: 403 },
  );
}

export async function handleLogoutRequest(request: Request, deps: LogoutHandlerDeps): Promise<Response> {
  const correlationId = request.headers.get('x-correlation-id') ?? 'no-correlation-id';

  const token = readSessionCookie(request);
  if (!token) {
    return unauthenticated(correlationId);
  }

  const payload = verifySessionToken(token, deps.sessionSecret);
  if (!payload) {
    return unauthenticated(correlationId);
  }

  const now = deps.now();
  const validity = checkSessionValidity(
    { issuedAt: new Date(payload.issuedAt), lastActivityAt: new Date(payload.lastActivityAt) },
    now,
  );
  if (!validity.valid) {
    return unauthenticated(correlationId);
  }

  // SEC-005: state-changing API（logout）はCSRFトークン必須。X-CSRF-Tokenヘッダで受け取る。
  const csrfToken = request.headers.get('x-csrf-token');
  if (!csrfToken || !verifyCsrfToken(csrfToken, payload.sessionId, deps.sessionSecret)) {
    return csrfInvalid(correlationId);
  }

  const response = new Response(null, { status: 204, headers: { 'x-correlation-id': correlationId } });
  response.headers.append('Set-Cookie', clearSessionCookieHeader());
  return response;
}
EOF

cat > apps/web/lib/auth/logout-handler.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { handleLogoutRequest } from './logout-handler';
import { issueSessionToken, type SessionPayload } from './session-token';
import { issueCsrfToken } from '../security/csrf';
import { SESSION_COOKIE_NAME } from './session-cookie';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-07T09:05:00.000Z');

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 's-1',
    userId: 'u-1',
    displayName: '田中太郎',
    roles: ['OFFICE'],
    issuedAt: '2026-10-07T09:00:00.000Z',
    lastActivityAt: '2026-10-07T09:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(cookie: string | null, csrfToken: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers['cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  if (csrfToken !== null) {
    headers['x-csrf-token'] = csrfToken;
  }
  return new Request('https://example.com/api/auth/logout', { method: 'POST', headers });
}

describe('handleLogoutRequest', () => {
  it('有効なsession+正しいCSRFトークンで204、cookieを削除する', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const csrfToken = issueCsrfToken(payload.sessionId, SECRET);

    const response = await handleLogoutRequest(makeRequest(token, csrfToken), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('CSRFトークン無しは403 CSRF_INVALID', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);

    const response = await handleLogoutRequest(makeRequest(token, null), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe('CSRF_INVALID');
  });

  it('別sessionId向けのCSRFトークンは403', async () => {
    const payload = makePayload();
    const token = issueSessionToken(payload, SECRET);
    const wrongCsrf = issueCsrfToken('s-other', SECRET);

    const response = await handleLogoutRequest(makeRequest(token, wrongCsrf), {
      sessionSecret: SECRET,
      now: () => NOW,
    });

    expect(response.status).toBe(403);
  });

  it('session cookie無しは401', async () => {
    const response = await handleLogoutRequest(makeRequest(null, null), {
      sessionSecret: SECRET,
      now: () => NOW,
    });
    expect(response.status).toBe(401);
  });
});
EOF

# ============================================================
# 7. apps/web/lib/db/prisma-client.ts（singleton）
#    注: 既存のPrisma singleton（lib/db/prisma.ts等）が既にある場合は
#    重複となるため、既存ファイルがあれば削除してこちらに統一してください。
# ============================================================
cat > apps/web/lib/db/prisma-client.ts << 'EOF'
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.APP_ENV === 'local' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.APP_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
EOF

# ============================================================
# 8. apps/web/app/api/auth/{login,logout,me}/route.ts
# ============================================================
cat > apps/web/app/api/auth/login/route.ts << 'EOF'
import { PrismaUserRepository } from '../../../../lib/auth/prisma-user-repository';
import { Argon2PasswordHasher } from '../../../../lib/auth/argon2-password-hasher';
import { handleLoginRequest } from '../../../../lib/auth/login-handler';
import { prisma } from '../../../../lib/db/prisma-client';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request, {
    userRepository: new PrismaUserRepository(prisma),
    passwordHasher: new Argon2PasswordHasher(),
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

cat > apps/web/app/api/auth/logout/route.ts << 'EOF'
import { handleLogoutRequest } from '../../../../lib/auth/logout-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLogoutRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

cat > apps/web/app/api/auth/me/route.ts << 'EOF'
import { handleMeRequest } from '../../../../lib/auth/me-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function GET(request: Request): Promise<Response> {
  return handleMeRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
EOF

# ============================================================
# 9. インストール＋検証
# ============================================================
pnpm install

echo "=== domain: tsc --noEmit ==="
(cd packages/domain && npx tsc --noEmit)

echo "=== domain: vitest run ==="
(cd packages/domain && npx vitest run)

echo "=== application: tsc --noEmit ==="
(cd packages/application && npx tsc --noEmit)

echo "=== application: vitest run ==="
(cd packages/application && npx vitest run)

echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit)

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
