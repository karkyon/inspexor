/**
 * INSPEXOR_用語・状態・コード定義書_v5.1.md 「error code」の17件を正本とする。
 *
 * GAP: 同資料§7「Error辞書」は
 * 「全error codeはHTTP status、利用者向けmessage、retryable、監査要否を一意に定義し、
 *   未登録codeを返さない」という方針のみを記載し、17件個別のHTTP status/retryable表は
 * 資料検索では見つからなかった。
 *
 * 下表 evidence='documented' は、API・イベント設計書の一般status表
 * （400/401/403/404/409/422/423/429/500/503）および個別endpoint/試験ID
 * （T-AUTH-001=423、T-CSRF-001=403、VERSION_CONFLICT例=409、T-IDEM-002=409、
 *  SEC-009/rate=429、503=dependency、500=unexpected）から直接裏付けられるもの。
 * evidence='derived' は、該当APIの失敗status集合（多くは{409,422}）からの
 * 妥当な推論であり、仕様正本の確定値ではない。未決事項・変更管理台帳へのGAP登録を推奨する。
 */

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'ACCOUNT_LOCKED'
  | 'CSRF_INVALID'
  | 'VALIDATION_ERROR'
  | 'VERSION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MASTER_INACTIVE'
  | 'RULE_NOT_FOUND'
  | 'RULE_AMBIGUOUS'
  | 'SOURCE_CHANGED'
  | 'RECIPIENT_EMPTY'
  | 'TEMPLATE_INVALID'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ErrorDictionaryEntry {
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly evidence: 'documented' | 'derived';
}

export const ERROR_DICTIONARY: Readonly<Record<ErrorCode, ErrorDictionaryEntry>> = {
  AUTH_REQUIRED: { httpStatus: 401, retryable: false, evidence: 'documented' },
  FORBIDDEN: { httpStatus: 403, retryable: false, evidence: 'documented' },
  ACCOUNT_LOCKED: { httpStatus: 423, retryable: false, evidence: 'documented' },
  CSRF_INVALID: { httpStatus: 403, retryable: false, evidence: 'documented' },
  VALIDATION_ERROR: { httpStatus: 422, retryable: false, evidence: 'documented' },
  VERSION_CONFLICT: { httpStatus: 409, retryable: false, evidence: 'documented' },
  STATE_CONFLICT: { httpStatus: 409, retryable: false, evidence: 'documented' },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, retryable: false, evidence: 'documented' },
  MASTER_INACTIVE: { httpStatus: 422, retryable: false, evidence: 'derived' },
  RULE_NOT_FOUND: { httpStatus: 422, retryable: false, evidence: 'derived' },
  RULE_AMBIGUOUS: { httpStatus: 422, retryable: false, evidence: 'derived' },
  SOURCE_CHANGED: { httpStatus: 409, retryable: false, evidence: 'derived' },
  RECIPIENT_EMPTY: { httpStatus: 422, retryable: false, evidence: 'derived' },
  TEMPLATE_INVALID: { httpStatus: 422, retryable: false, evidence: 'derived' },
  DEPENDENCY_UNAVAILABLE: { httpStatus: 503, retryable: true, evidence: 'documented' },
  RATE_LIMITED: { httpStatus: 429, retryable: true, evidence: 'documented' },
  INTERNAL_ERROR: { httpStatus: 500, retryable: true, evidence: 'documented' },
};

export function lookupErrorCode(code: ErrorCode): ErrorDictionaryEntry {
  return ERROR_DICTIONARY[code];
}
