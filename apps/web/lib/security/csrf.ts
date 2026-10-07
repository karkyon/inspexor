/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-005準拠。
 * 全state-changing API（command）はCSRF token必須。
 *
 * 方式: HMAC-based double-submit token。
 * token = base64url(nonce) + '.' + base64url(HMAC-SHA256(secret, sessionId + '.' + nonce))
 * サーバーはAUTH_SECRET等のsecretとsessionIdのみを保持し、tokenはクライアントに
 * 返却してリクエストヘッダ（例: X-CSRF-Token）で往復させる。secret自体はclientへ渡さない。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NONCE_BYTES = 18;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function hmac(secret: string, sessionId: string, nonce: string): Buffer {
  return createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest();
}

export function issueCsrfToken(sessionId: string, secret: string): string {
  const nonce = base64url(randomBytes(NONCE_BYTES));
  const signature = base64url(hmac(secret, sessionId, nonce));
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(token: string, sessionId: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [nonce, signature] = parts;
  if (!nonce || !signature) {
    return false;
  }
  const expected = base64url(hmac(secret, sessionId, nonce));
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
