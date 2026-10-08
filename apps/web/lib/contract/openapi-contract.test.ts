/**
 * G0-CONTRACT: openapi.yaml（仕様正本 ART-04）と実装の照合。
 *  1. 実装済みroute（app/api/v1/**\/route.ts の export method）がopenapiに存在すること（余分なendpoint=drift）
 *  2. auth系handlerの実レスポンスがopenapiのresponse schemaに適合すること
 *  3. LoginRequestのZodスキーマとopenapiスキーマの受理/拒否が境界値で一致すること
 *  4. session cookie名がsecuritySchemes.cookieAuth.nameと一致すること
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { UserRecord, UserRepository, PasswordHasher } from '@inspexor/application';
import { handleLoginRequest } from '../auth/login-handler';
import { handleMeRequest } from '../auth/me-handler';
import { handleLogoutRequest } from '../auth/logout-handler';
import { loginRequestSchema } from '../auth/login-request-schema';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return join(start, '..', '..');
    dir = parent;
  }
}

function findOpenApi(root: string): string {
  const fromEnv = process.env['OPENAPI_PATH'];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'dist'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'openapi.yaml') return full;
    }
  }
  throw new Error(`openapi.yaml がリポジトリ内に見つかりません（root=${root}）`);
}

type OpenApiDoc = {
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: { cookieAuth: { name: string } } };
};

const openapiPath = findOpenApi(findRepoRoot(webRoot));
const doc = parse(readFileSync(openapiPath, 'utf8')) as OpenApiDoc;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...doc, $id: 'openapi' });
const validator = (pointer: string) => {
  const v = ajv.getSchema(`openapi#${pointer}`);
  if (!v) throw new Error(`schema not found: ${pointer}`);
  return v;
};
const RESPONSE_JSON = '/content/application~1json/schema';
const sessionSchema = validator(`/components/responses/Session${RESPONSE_JSON}`);
const errorSchema = validator(`/components/responses/Error${RESPONSE_JSON}`);
const loginRequestOpenApi = validator('/components/schemas/LoginRequest');

function expectValid(v: ReturnType<typeof validator>, body: unknown): void {
  const ok = v(body);
  expect(ok, JSON.stringify(v.errors)).toBe(true);
}

// ---- 1. route drift ----
function collectRoutes(): Array<{ path: string; method: string }> {
  const base = join(webRoot, 'app', 'api', 'v1');
  const out: Array<{ path: string; method: string }> = [];
  if (!existsSync(base)) return out;
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'route.ts') {
        const segs = relative(base, dir).split(sep).filter((s) => s.length > 0);
        const apiPath = '/' + segs.map((s) => s.replace(/^\[(.+)\]$/, '{$1}')).join('/');
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
          out.push({ path: apiPath, method: (m[1] as string).toLowerCase() });
        }
      }
    }
  }
  return out;
}

describe('G0-CONTRACT: route drift', () => {
  const routes = collectRoutes();
  it('実装routeが1件以上ある', () => {
    expect(routes.length).toBeGreaterThan(0);
  });
  it.each(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
    '%s はopenapiに定義されている',
    (_label, r) => {
      const pathItem = doc.paths[r.path];
      expect(pathItem, `openapiに無いpath: ${r.path}`).toBeDefined();
      expect(pathItem?.[r.method], `openapiに無いmethod: ${r.method} ${r.path}`).toBeDefined();
    },
  );
  it('session cookie名がsecuritySchemes.cookieAuth.nameと一致', () => {
    expect(SESSION_COOKIE_NAME).toBe(doc.components.securitySchemes.cookieAuth.name);
  });
});

// ---- 2. response schema ----
const SECRET = 'c'.repeat(32);
const NOW = new Date('2026-10-08T03:00:00.000Z');
const USER: UserRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  loginId: 'dev-admin',
  passwordHash: '$argon2id$dummy',
  displayName: '開発用管理者',
  status: 'ACTIVE',
  roles: ['ADMIN'],
  failedAttempts: 0,
  lockedUntil: null,
};
function deps(passwordOk: boolean, user: UserRecord | null = USER) {
  const userRepository: UserRepository = {
    findByLoginId: async () => user,
    updateLockoutState: async () => undefined,
  };
  const passwordHasher: PasswordHasher = { verify: async () => passwordOk };
  return { userRepository, passwordHasher, sessionSecret: SECRET, now: () => NOW };
}
function loginReq(body: unknown): Request {
  return new Request('https://example.com/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

describe('G0-CONTRACT: API-001 POST /auth/login', () => {
  it('200はSession schema適合、correlationIdヘッダ付き', async () => {
    const res = await handleLoginRequest(loginReq({ loginId: 'dev-admin', password: 'correct-password' }), deps(true));
    expect(res.status).toBe(200);
    expectValid(sessionSchema, await res.json());
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('401はError schema適合（correlationIdはuuid）', async () => {
    const res = await handleLoginRequest(loginReq({ loginId: 'dev-admin', password: 'wrong-password' }), deps(false));
    expect(res.status).toBe(401);
    expectValid(errorSchema, await res.json());
  });
  it('422（VALIDATION_ERROR）もError schema適合、fieldsにpath/code/message', async () => {
    const res = await handleLoginRequest(loginReq({ loginId: 'dev-admin', password: 'short' }), deps(true));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: Array<{ path: string; code: string }> } };
    expectValid(errorSchema, body);
    expect(body.error.fields[0]?.path).toBe('/password');
  });
});

describe('G0-CONTRACT: API-003 GET /me / API-002 POST /auth/logout', () => {
  it('ログイン後 /me 200はSession schema適合', async () => {
    const login = await handleLoginRequest(loginReq({ loginId: 'dev-admin', password: 'correct-password' }), deps(true));
    const res = await handleMeRequest(
      new Request('https://example.com/api/v1/me', { headers: { cookie: cookieFrom(login) } }),
      { sessionSecret: SECRET, now: () => new Date(NOW.getTime() + 60_000) },
    );
    expect(res.status).toBe(200);
    expectValid(sessionSchema, await res.json());
  });
  it('未認証 /me 401はError schema適合', async () => {
    const res = await handleMeRequest(new Request('https://example.com/api/v1/me'), { sessionSecret: SECRET, now: () => NOW });
    expect(res.status).toBe(401);
    expectValid(errorSchema, await res.json());
  });
  it('logout 204（body無し）、未認証は401 Error schema適合', async () => {
    const login = await handleLoginRequest(loginReq({ loginId: 'dev-admin', password: 'correct-password' }), deps(true));
    const { data } = (await login.json()) as { data: { csrfToken: string } };
    const ok = await handleLogoutRequest(
      new Request('https://example.com/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie: cookieFrom(login), 'x-csrf-token': data.csrfToken },
      }),
      { sessionSecret: SECRET, now: () => NOW },
    );
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    const ng = await handleLogoutRequest(new Request('https://example.com/api/v1/auth/logout', { method: 'POST' }), {
      sessionSecret: SECRET,
      now: () => NOW,
    });
    expect(ng.status).toBe(401);
    expectValid(errorSchema, await ng.json());
  });
});

// ---- 3. request schema 同値性 ----
describe('G0-CONTRACT: LoginRequest Zod ⇔ openapi', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['正常', { loginId: 'a', password: 'p'.repeat(8) }],
    ['loginId 100文字', { loginId: 'a'.repeat(100), password: 'p'.repeat(8) }],
    ['loginId 101文字', { loginId: 'a'.repeat(101), password: 'p'.repeat(8) }],
    ['loginId 空', { loginId: '', password: 'p'.repeat(8) }],
    ['password 7文字', { loginId: 'a', password: 'p'.repeat(7) }],
    ['password 128文字', { loginId: 'a', password: 'p'.repeat(128) }],
    ['password 129文字', { loginId: 'a', password: 'p'.repeat(129) }],
    ['未知field', { loginId: 'a', password: 'p'.repeat(8), extra: 1 }],
    ['password欠落', { loginId: 'a' }],
    ['loginId数値', { loginId: 1, password: 'p'.repeat(8) }],
  ];
  it.each(cases)('%s: 受理/拒否が一致', (_label, input) => {
    expect(loginRequestSchema.safeParse(input).success).toBe(loginRequestOpenApi(input));
  });
});
