import { describe, it, expect } from 'vitest';
import { signFileUrl, verifyFileSignature } from './signed-url';

const S = 's'.repeat(32);
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-08T03:00:00Z');

describe('署名付き URL（SEC-013: 10分）', () => {
  it('発行した URL は10分間だけ有効', () => {
    const { url, expiresAt } = signFileUrl(ID, NOW, S);
    expect(expiresAt).toBe('2026-10-08T03:10:00.000Z');
    const q = new URL(url, 'https://x').searchParams;
    expect(verifyFileSignature(ID, q.get('exp'), q.get('sig'), new Date(NOW.getTime() + 599_000), S)).toBe(true);
    expect(verifyFileSignature(ID, q.get('exp'), q.get('sig'), new Date(NOW.getTime() + 601_000), S)).toBe(false);
  });
  it('別ファイル・改ざん・別 secret・欠落は無効', () => {
    const q = new URL(signFileUrl(ID, NOW, S).url, 'https://x').searchParams;
    expect(verifyFileSignature('22222222-2222-4222-8222-222222222222', q.get('exp'), q.get('sig'), NOW, S)).toBe(false);
    expect(verifyFileSignature(ID, String(Number(q.get('exp')) + 1), q.get('sig'), NOW, S)).toBe(false);
    expect(verifyFileSignature(ID, q.get('exp'), q.get('sig'), NOW, 't'.repeat(32))).toBe(false);
    expect(verifyFileSignature(ID, null, q.get('sig'), NOW, S)).toBe(false);
    expect(verifyFileSignature(ID, 'abc', q.get('sig'), NOW, S)).toBe(false);
  });
});
