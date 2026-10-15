import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly issuedAt: string;
  readonly lastActivityAt: string;
  /** CHG-012: 最後にパスワード（と確認コード）で認証した時刻。無い旧 session は issuedAt と同じ */
  readonly authAt?: string;
  /** CHG-012: 多要素認証を済ませた session（ADMIN_MFA_ENABLED のとき管理者に必要） */
  readonly mfa?: boolean;
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
    typeof candidate['lastActivityAt'] === 'string' &&
    (candidate['authAt'] === undefined || typeof candidate['authAt'] === 'string') &&
    (candidate['mfa'] === undefined || typeof candidate['mfa'] === 'boolean')
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
