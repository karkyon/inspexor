/**
 * 帳票の署名付き URL（SEC-013: 10分、scoped authorization 後に発行）:
 * `/api/files/{fileId}?exp={unix秒}&sig={HMAC-SHA256}`。CHG-006: 本番（Cloud Storage）も同じ配信口から返す。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNED_URL_TTL_SECONDS = 600;

function signature(fileId: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`file:${fileId}.${exp}`).digest('base64url');
}

export function signFileUrl(fileId: string, now: Date, secret: string): { url: string; expiresAt: string } {
  const exp = Math.floor(now.getTime() / 1000) + SIGNED_URL_TTL_SECONDS;
  return { url: `/api/files/${fileId}?exp=${exp}&sig=${signature(fileId, exp, secret)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyFileSignature(fileId: string, expRaw: string | null, sig: string | null, now: Date, secret: string): boolean {
  if (expRaw === null || sig === null || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (exp * 1000 < now.getTime()) return false;
  const expected = Buffer.from(signature(fileId, exp, secret));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
