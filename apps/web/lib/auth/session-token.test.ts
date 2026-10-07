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
