import { describe, it, expect } from 'vitest';
import { decideIdempotency, type IdempotencyRecord } from './idempotency';

const NOW = new Date('2026-10-07T00:00:00Z');
const FUTURE = new Date('2026-10-08T00:00:00Z');
const PAST = new Date('2026-10-06T00:00:00Z');

describe('idempotency: 00契約 不変条件3 準拠', () => {
  it('既存recordがない場合はPROCEED', () => {
    expect(decideIdempotency(null, 'hash-a', NOW)).toEqual({ action: 'PROCEED' });
  });

  it('expiresAtを過ぎている場合はPROCEED（新規扱い）', () => {
    const existing: IdempotencyRecord = { requestHash: 'hash-a', status: 'COMPLETED', expiresAt: PAST };
    expect(decideIdempotency(existing, 'hash-a', NOW)).toEqual({ action: 'PROCEED' });
  });

  it('同key・異hashはCONFLICT', () => {
    const existing: IdempotencyRecord = { requestHash: 'hash-a', status: 'COMPLETED', expiresAt: FUTURE };
    expect(decideIdempotency(existing, 'hash-b', NOW)).toEqual({ action: 'CONFLICT' });
  });

  it('同key・同hash・COMPLETEDはREPLAY', () => {
    const existing: IdempotencyRecord = {
      requestHash: 'hash-a', status: 'COMPLETED', expiresAt: FUTURE, responseStatus: 200, responseBody: { ok: true },
    };
    expect(decideIdempotency(existing, 'hash-a', NOW)).toEqual({ action: 'REPLAY', responseStatus: 200, responseBody: { ok: true } });
  });

  it('同key・同hash・PROCESSINGはIN_PROGRESS', () => {
    const existing: IdempotencyRecord = { requestHash: 'hash-a', status: 'PROCESSING', expiresAt: FUTURE };
    expect(decideIdempotency(existing, 'hash-a', NOW)).toEqual({ action: 'IN_PROGRESS' });
  });

  it('同key・同hash・FAILEDはPROCEED（derived解釈）', () => {
    const existing: IdempotencyRecord = { requestHash: 'hash-a', status: 'FAILED', expiresAt: FUTURE };
    expect(decideIdempotency(existing, 'hash-a', NOW)).toEqual({ action: 'PROCEED' });
  });
});
