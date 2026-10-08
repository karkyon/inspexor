import { describe, it, expect } from 'vitest';
import { resolveCorrelationId } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('UUIDヘッダはそのまま使う', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(resolveCorrelationId(new Request('https://x/', { headers: { 'x-correlation-id': id } }))).toBe(id);
  });
  it('ヘッダ無しはUUIDv4を発行', () => {
    expect(resolveCorrelationId(new Request('https://x/'))).toMatch(UUID);
  });
  it('UUIDでないヘッダは無視して発行', () => {
    expect(resolveCorrelationId(new Request('https://x/', { headers: { 'x-correlation-id': 'abc' } }))).toMatch(UUID);
  });
});
