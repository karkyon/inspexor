import { describe, it, expect } from 'vitest';
import { ERROR_DICTIONARY, lookupErrorCode, type ErrorCode } from './error-codes';

const EXPECTED_CODES: readonly ErrorCode[] = [
  'AUTH_REQUIRED', 'FORBIDDEN', 'ACCOUNT_LOCKED', 'CSRF_INVALID',
  'VALIDATION_ERROR', 'VERSION_CONFLICT', 'STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'MASTER_INACTIVE', 'RULE_NOT_FOUND', 'RULE_AMBIGUOUS', 'SOURCE_CHANGED',
  'RECIPIENT_EMPTY', 'TEMPLATE_INVALID', 'DEPENDENCY_UNAVAILABLE', 'RATE_LIMITED',
  'INTERNAL_ERROR',
];

describe('error-codes: 用語・状態・コード定義書 17件準拠', () => {
  it('17コードすべてが辞書に存在する', () => {
    expect(Object.keys(ERROR_DICTIONARY).sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it('全エントリが有効なHTTP statusを持つ', () => {
    const validStatuses = [401, 403, 409, 422, 423, 429, 500, 503];
    for (const code of EXPECTED_CODES) {
      expect(validStatuses).toContain(lookupErrorCode(code).httpStatus);
    }
  });

  it('documented由来のコードは直接根拠を持つ', () => {
    const documented: readonly ErrorCode[] = [
      'AUTH_REQUIRED', 'FORBIDDEN', 'ACCOUNT_LOCKED', 'CSRF_INVALID',
      'VALIDATION_ERROR', 'VERSION_CONFLICT', 'STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT',
      'DEPENDENCY_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL_ERROR',
    ];
    for (const code of documented) {
      expect(lookupErrorCode(code).evidence).toBe('documented');
    }
  });
});
