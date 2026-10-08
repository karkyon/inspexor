/**
 * 帳票の署名付き URL（SEC-013: 10分、scoped authorization 後に発行）。開発用 storage adapter 向け:
 * `/api/files/{fileId}?exp={unix秒}&sig={HMAC-SHA256}`。本番は Cloud Storage の V4 署名 URL（G9）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** worker の LocalFsStorage と同じ場所（開発用） */
export function storageDir(): string {
  return process.env['STORAGE_DIR'] ?? join(homedir(), '.inspexor-storage');
}
