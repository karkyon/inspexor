/**
 * CHG-012 TOTP（RFC 6238 / RFC 4226）。Google Authenticator・Microsoft Authenticator などの認証アプリと同じ方式:
 * HMAC-SHA1・30 秒・6 桁、秘密鍵は 20 バイト（Base32 で表示）。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS, TOTP_WINDOW } from '@inspexor/domain';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin = (((mac[offset] as number) & 0x7f) << 24) | ((mac[offset + 1] as number) << 16) | ((mac[offset + 2] as number) << 8) | (mac[offset + 3] as number);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totp(secret: Buffer, nowMs: number): string {
  return hotp(secret, totpStep(nowMs));
}

/**
 * 確認コードを照合する。前後 TOTP_WINDOW 区間まで許し、lastStep 以前の区間（使用済み）は受け付けない。一致した区間を返す
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastStep: number): number | null {
  const current = totpStep(nowMs);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d += 1) {
    const step = current + d;
    if (step <= lastStep) continue;
    const expected = hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ (code.charCodeAt(i) || 0);
    if (diff === 0 && code.length === expected.length) return step;
  }
  return null;
}

/** 認証アプリに登録する URI（QR コードの中身） */
export function otpauthUri(secretBase32: string, account: string, issuer = 'INSPEXOR'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
