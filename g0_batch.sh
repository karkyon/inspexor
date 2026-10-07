cd ~/inspexor

# ============================================================
# 1. packages/domain/src/record-status.ts
# ============================================================
cat > packages/domain/src/record-status.ts << 'EOF'
/**
 * INSPEXOR_システム基本設計書_v5.1.md §状態遷移（Record行）準拠。
 * ownership/version/業務制約などDB参照を要するguardはapplication層の責務であり、
 * ここではrole/owner検証とreason必須検証のみを行う（domainはframework/DB非依存）。
 */

export type RecordStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'REVOKED'
  | 'BILLING_LOCKED';

export type RecordRole = 'FIELD' | 'OFFICE' | 'ADMIN' | 'AUDITOR' | 'SYSTEM';

export type RecordCommand =
  | 'confirm'
  | 'documentGenerated'
  | 'approve'
  | 'reject'
  | 'revoke'
  | 'revise'
  | 'billingFinalize';

export interface RecordTransitionRule {
  readonly from: RecordStatus;
  readonly command: RecordCommand;
  readonly to: RecordStatus;
  readonly ownerAllowed: boolean;
  readonly allowedRoles: readonly RecordRole[];
  readonly reasonRequired: boolean;
  readonly guardNote: string;
}

export const RECORD_TRANSITIONS: readonly RecordTransitionRule[] = [
  { from: 'DRAFT', command: 'confirm', to: 'CONFIRMED', ownerAllowed: true, allowedRoles: ['OFFICE', 'ADMIN'], reasonRequired: false, guardNote: 'current version、全検証' },
  { from: 'CONFIRMED', command: 'documentGenerated', to: 'SUBMITTED', ownerAllowed: false, allowedRoles: ['SYSTEM'], reasonRequired: false, guardNote: 'PDF hash有' },
  { from: 'SUBMITTED', command: 'approve', to: 'APPROVED', ownerAllowed: false, allowedRoles: ['OFFICE', 'ADMIN'], reasonRequired: false, guardNote: 'current revision' },
  { from: 'SUBMITTED', command: 'reject', to: 'REJECTED', ownerAllowed: false, allowedRoles: ['OFFICE', 'ADMIN'], reasonRequired: true, guardNote: '理由必須' },
  { from: 'APPROVED', command: 'revoke', to: 'REVOKED', ownerAllowed: false, allowedRoles: ['OFFICE', 'ADMIN'], reasonRequired: true, guardNote: '未billing lock、理由（fromがAPPROVEDである時点でbilling lock前提は成立）' },
  { from: 'REJECTED', command: 'revise', to: 'DRAFT', ownerAllowed: true, allowedRoles: ['OFFICE'], reasonRequired: false, guardNote: 'parent revision' },
  { from: 'REVOKED', command: 'revise', to: 'DRAFT', ownerAllowed: true, allowedRoles: ['OFFICE'], reasonRequired: false, guardNote: 'parent revision' },
  { from: 'APPROVED', command: 'billingFinalize', to: 'BILLING_LOCKED', ownerAllowed: false, allowedRoles: ['SYSTEM'], reasonRequired: false, guardNote: 'run finalizing' },
] as const;

export interface RecordActor {
  readonly roles: readonly RecordRole[];
  readonly isOwner: boolean;
}

export type RecordTransitionResult =
  | { readonly ok: true; readonly to: RecordStatus }
  | { readonly ok: false; readonly errorCode: 'STATE_CONFLICT' | 'FORBIDDEN' | 'VALIDATION_ERROR'; readonly message: string };

export function resolveRecordTransition(
  from: RecordStatus,
  command: RecordCommand,
  actor: RecordActor,
  reason?: string,
): RecordTransitionResult {
  const rule = RECORD_TRANSITIONS.find((r) => r.from === from && r.command === command);
  if (!rule) {
    return { ok: false, errorCode: 'STATE_CONFLICT', message: `${from}からcommand ${command}への遷移は定義されていません。` };
  }

  const isSystemOnly = rule.allowedRoles.length === 1 && rule.allowedRoles[0] === 'SYSTEM';
  const roleMatches = isSystemOnly
    ? actor.roles.includes('SYSTEM')
    : actor.roles.some((role) => rule.allowedRoles.includes(role)) || (rule.ownerAllowed && actor.isOwner);

  if (!roleMatches) {
    const label = rule.ownerAllowed ? `owner または ${rule.allowedRoles.join('/')}` : rule.allowedRoles.join('/');
    return { ok: false, errorCode: 'FORBIDDEN', message: `この遷移には${label}権限が必要です。` };
  }

  if (rule.reasonRequired && (!reason || reason.trim().length === 0)) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', message: 'reasonは必須です。' };
  }

  return { ok: true, to: rule.to };
}
EOF

# ============================================================
# 2. packages/domain/src/billing-status.ts
# ============================================================
cat > packages/domain/src/billing-status.ts << 'EOF'
/**
 * INSPEXOR_システム基本設計書_v5.1.md §状態遷移（Billing行）準拠。
 *
 * GAP: schema.sqlのapp.billing_statusにはVOIDEDが定義されているが、
 * どの資料にもVOIDEDへの遷移元/遷移先/guard/roleの記載が見つからなかった。
 * 推測で遷移を作らず、未解決のまま UNDOCUMENTED_BILLING_STATES として明示する。
 * （未決事項・変更管理台帳へのGAP登録を推奨）
 */

export type BillingStatus =
  | 'OPEN'
  | 'CALCULATING'
  | 'CALCULATED'
  | 'NEEDS_REVIEW'
  | 'REVIEWED'
  | 'FINALIZED'
  | 'ISSUED'
  | 'SENT'
  | 'VOIDED';

export const UNDOCUMENTED_BILLING_STATES: readonly BillingStatus[] = ['VOIDED'] as const;

export type BillingRole = 'OFFICE' | 'ADMIN' | 'SYSTEM';

export type BillingCommand = 'calculate' | 'complete' | 'review' | 'finalize' | 'issue' | 'mailSent';

export interface BillingTransitionRule {
  readonly from: BillingStatus;
  readonly command: BillingCommand;
  readonly to: BillingStatus | { readonly withWarnings: BillingStatus; readonly withoutWarnings: BillingStatus };
  readonly allowedRoles: readonly BillingRole[];
  readonly guardNote: string;
}

export const BILLING_TRANSITIONS: readonly BillingTransitionRule[] = [
  { from: 'OPEN', command: 'calculate', to: 'CALCULATING', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'period unique' },
  { from: 'CALCULATING', command: 'complete', to: { withWarnings: 'NEEDS_REVIEW', withoutWarnings: 'CALCULATED' }, allowedRoles: ['SYSTEM'], guardNote: 'warning有無' },
  { from: 'NEEDS_REVIEW', command: 'review', to: 'REVIEWED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: '全warning disposition' },
  { from: 'CALCULATED', command: 'finalize', to: 'FINALIZED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'source versions一致' },
  { from: 'REVIEWED', command: 'finalize', to: 'FINALIZED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'source versions一致' },
  { from: 'FINALIZED', command: 'issue', to: 'ISSUED', allowedRoles: ['SYSTEM'], guardNote: 'PDF hash有' },
  { from: 'ISSUED', command: 'mailSent', to: 'SENT', allowedRoles: ['SYSTEM'], guardNote: 'provider id有' },
] as const;

export interface BillingActor {
  readonly roles: readonly BillingRole[];
}

export type BillingTransitionResult =
  | { readonly ok: true; readonly to: BillingStatus }
  | { readonly ok: false; readonly errorCode: 'STATE_CONFLICT' | 'FORBIDDEN' | 'VALIDATION_ERROR'; readonly message: string };

export function resolveBillingTransition(
  from: BillingStatus,
  command: BillingCommand,
  actor: BillingActor,
  options?: { readonly hasWarnings?: boolean },
): BillingTransitionResult {
  const rule = BILLING_TRANSITIONS.find((r) => r.from === from && r.command === command);
  if (!rule) {
    return { ok: false, errorCode: 'STATE_CONFLICT', message: `${from}からcommand ${command}への遷移は定義されていません。` };
  }

  const roleMatches = rule.allowedRoles.includes('SYSTEM')
    ? actor.roles.includes('SYSTEM')
    : actor.roles.some((role) => rule.allowedRoles.includes(role));

  if (!roleMatches) {
    return { ok: false, errorCode: 'FORBIDDEN', message: `この遷移には${rule.allowedRoles.join('/')}権限が必要です。` };
  }

  if (typeof rule.to === 'string') {
    return { ok: true, to: rule.to };
  }

  if (options?.hasWarnings === undefined) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', message: 'completeコマンドにはhasWarningsの指定が必要です。' };
  }

  return { ok: true, to: options.hasWarnings ? rule.to.withWarnings : rule.to.withoutWarnings };
}
EOF

# ============================================================
# 3. packages/domain/src/error-codes.ts
# ============================================================
cat > packages/domain/src/error-codes.ts << 'EOF'
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
EOF

# ============================================================
# 4. packages/domain/src/idempotency.ts
# ============================================================
cat > packages/domain/src/idempotency.ts << 'EOF'
/**
 * 00_INSPEXOR_仕様正本_Claude実装契約_v5.1.md 不変条件3および
 * schema.sql idempotency_records（actor_id+route+idempotency_key一意、
 * request_hash char(64)、status IN (PROCESSING,COMPLETED,FAILED)、expires_at）準拠。
 *
 * GAP: status=FAILEDの場合の再実行可否は00契約に明記がない。
 * 本実装は「同key・同hashであれば再実行を許可する(PROCEED)」という解釈(derived)を採る。
 * 未決事項・変更管理台帳へのGAP登録を推奨する。
 */

export type IdempotencyRecordStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly status: IdempotencyRecordStatus;
  readonly expiresAt: Date;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
}

export type IdempotencyDecision =
  | { readonly action: 'PROCEED' }
  | { readonly action: 'REPLAY'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly action: 'IN_PROGRESS' }
  | { readonly action: 'CONFLICT' };

export function decideIdempotency(
  existing: IdempotencyRecord | null,
  requestHash: string,
  now: Date,
): IdempotencyDecision {
  if (!existing) {
    return { action: 'PROCEED' };
  }

  if (existing.expiresAt.getTime() <= now.getTime()) {
    // 24時間window超過。00契約§3.3の対象外であり新規requestとして扱う。
    return { action: 'PROCEED' };
  }

  if (existing.requestHash !== requestHash) {
    // 同一key・異hash → 409 IDEMPOTENCY_CONFLICT（不変条件3）
    return { action: 'CONFLICT' };
  }

  if (existing.status === 'COMPLETED') {
    return { action: 'REPLAY', responseStatus: existing.responseStatus ?? 200, responseBody: existing.responseBody };
  }

  if (existing.status === 'PROCESSING') {
    return { action: 'IN_PROGRESS' };
  }

  // FAILED: derived（仕様未記載、GAP）
  return { action: 'PROCEED' };
}

export const IDEMPOTENCY_REQUEST_HASH_LENGTH = 64; // schema.sql: request_hash char(64) (SHA-256 hex)
export const IDEMPOTENCY_WINDOW_HOURS = 24; // 00契約 不変条件3
EOF

# ============================================================
# 5. packages/domain/src/index.ts （全export統合）
# ============================================================
cat > packages/domain/src/index.ts << 'EOF'
export * from './money';
export * from './business-time';
export * from './rate-calculation';
export * from './transport-allocation';
export * from './tax';
export * from './record-status';
export * from './billing-status';
export * from './error-codes';
export * from './idempotency';
EOF

# ============================================================
# 6. テスト: record-status.test.ts
# ============================================================
cat > packages/domain/src/record-status.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { resolveRecordTransition } from './record-status';

describe('record-status: システム基本設計書 §状態遷移 準拠', () => {
  it('DRAFT -> confirm -> CONFIRMED (owner)', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['FIELD'], isOwner: true });
    expect(r).toEqual({ ok: true, to: 'CONFIRMED' });
  });

  it('DRAFT -> confirm -> CONFIRMED (OFFICE, not owner)', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['OFFICE'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'CONFIRMED' });
  });

  it('DRAFT -> confirm: FIELD非ownerは拒否', () => {
    const r = resolveRecordTransition('DRAFT', 'confirm', { roles: ['FIELD'], isOwner: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('FORBIDDEN');
  });

  it('CONFIRMED -> documentGenerated -> SUBMITTED (SYSTEMのみ)', () => {
    const ok = resolveRecordTransition('CONFIRMED', 'documentGenerated', { roles: ['SYSTEM'], isOwner: false });
    expect(ok).toEqual({ ok: true, to: 'SUBMITTED' });
    const ng = resolveRecordTransition('CONFIRMED', 'documentGenerated', { roles: ['ADMIN'], isOwner: false });
    expect(ng.ok).toBe(false);
  });

  it('SUBMITTED -> approve -> APPROVED', () => {
    const r = resolveRecordTransition('SUBMITTED', 'approve', { roles: ['OFFICE'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'APPROVED' });
  });

  it('SUBMITTED -> reject: reason必須', () => {
    const noReason = resolveRecordTransition('SUBMITTED', 'reject', { roles: ['ADMIN'], isOwner: false });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.errorCode).toBe('VALIDATION_ERROR');
    const withReason = resolveRecordTransition('SUBMITTED', 'reject', { roles: ['ADMIN'], isOwner: false }, '不良率超過');
    expect(withReason).toEqual({ ok: true, to: 'REJECTED' });
  });

  it('APPROVED -> revoke -> REVOKED: reason必須', () => {
    const r = resolveRecordTransition('APPROVED', 'revoke', { roles: ['OFFICE'], isOwner: false }, '客先訂正依頼');
    expect(r).toEqual({ ok: true, to: 'REVOKED' });
  });

  it('REJECTED/REVOKED -> revise -> DRAFT (owner or OFFICE)', () => {
    expect(resolveRecordTransition('REJECTED', 'revise', { roles: ['FIELD'], isOwner: true })).toEqual({ ok: true, to: 'DRAFT' });
    expect(resolveRecordTransition('REVOKED', 'revise', { roles: ['OFFICE'], isOwner: false })).toEqual({ ok: true, to: 'DRAFT' });
  });

  it('APPROVED -> billingFinalize -> BILLING_LOCKED (SYSTEMのみ)', () => {
    const r = resolveRecordTransition('APPROVED', 'billingFinalize', { roles: ['SYSTEM'], isOwner: false });
    expect(r).toEqual({ ok: true, to: 'BILLING_LOCKED' });
  });

  it('未定義の遷移はSTATE_CONFLICT', () => {
    const r = resolveRecordTransition('BILLING_LOCKED', 'confirm', { roles: ['ADMIN'], isOwner: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('STATE_CONFLICT');
  });
});
EOF

# ============================================================
# 7. テスト: billing-status.test.ts
# ============================================================
cat > packages/domain/src/billing-status.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { resolveBillingTransition, UNDOCUMENTED_BILLING_STATES } from './billing-status';

describe('billing-status: システム基本設計書 §状態遷移 準拠', () => {
  it('OPEN -> calculate -> CALCULATING', () => {
    const r = resolveBillingTransition('OPEN', 'calculate', { roles: ['OFFICE'] });
    expect(r).toEqual({ ok: true, to: 'CALCULATING' });
  });

  it('CALCULATING -> complete -> CALCULATED (warningなし) / NEEDS_REVIEW (warningあり)', () => {
    const withoutWarnings = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] }, { hasWarnings: false });
    expect(withoutWarnings).toEqual({ ok: true, to: 'CALCULATED' });
    const withWarnings = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] }, { hasWarnings: true });
    expect(withWarnings).toEqual({ ok: true, to: 'NEEDS_REVIEW' });
  });

  it('CALCULATING -> complete: hasWarnings未指定はVALIDATION_ERROR', () => {
    const r = resolveBillingTransition('CALCULATING', 'complete', { roles: ['SYSTEM'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('VALIDATION_ERROR');
  });

  it('NEEDS_REVIEW -> review -> REVIEWED', () => {
    const r = resolveBillingTransition('NEEDS_REVIEW', 'review', { roles: ['ADMIN'] });
    expect(r).toEqual({ ok: true, to: 'REVIEWED' });
  });

  it('CALCULATED/REVIEWED -> finalize -> FINALIZED', () => {
    expect(resolveBillingTransition('CALCULATED', 'finalize', { roles: ['OFFICE'] })).toEqual({ ok: true, to: 'FINALIZED' });
    expect(resolveBillingTransition('REVIEWED', 'finalize', { roles: ['OFFICE'] })).toEqual({ ok: true, to: 'FINALIZED' });
  });

  it('FINALIZED -> issue -> ISSUED (SYSTEMのみ)', () => {
    expect(resolveBillingTransition('FINALIZED', 'issue', { roles: ['SYSTEM'] })).toEqual({ ok: true, to: 'ISSUED' });
    const ng = resolveBillingTransition('FINALIZED', 'issue', { roles: ['ADMIN'] });
    expect(ng.ok).toBe(false);
  });

  it('ISSUED -> mailSent -> SENT (SYSTEMのみ)', () => {
    expect(resolveBillingTransition('ISSUED', 'mailSent', { roles: ['SYSTEM'] })).toEqual({ ok: true, to: 'SENT' });
  });

  it('VOIDEDは未解決状態としてマークされている', () => {
    expect(UNDOCUMENTED_BILLING_STATES).toContain('VOIDED');
  });

  it('未定義の遷移はSTATE_CONFLICT', () => {
    const r = resolveBillingTransition('VOIDED', 'calculate', { roles: ['ADMIN'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('STATE_CONFLICT');
  });
});
EOF

# ============================================================
# 8. テスト: error-codes.test.ts
# ============================================================
cat > packages/domain/src/error-codes.test.ts << 'EOF'
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
EOF

# ============================================================
# 9. テスト: idempotency.test.ts
# ============================================================
cat > packages/domain/src/idempotency.test.ts << 'EOF'
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
EOF

# ============================================================
# 10. packages/config/src/env.ts
# ============================================================
cat > packages/config/src/env.ts << 'EOF'
/**
 * INSPEXOR_インフラ・運用設計書_v5.1.md §9 環境変数完全台帳 準拠。
 * 固定値（JOB_MAX_ATTEMPTS=5、SIGNED_URL_TTL_SECONDS=600、TZ=UTC、
 * BUSINESS_TIMEZONE=Asia/Tokyo、BILLING_ALGORITHM_VERSION=BILL-2026-09-05）は
 * 台帳の「値=X」列どおりrefineで固定する。
 */
import { z } from 'zod';

const envSchema = z.object({
  APP_ENV: z.enum(['local', 'dev', 'stg', 'prod']),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  STORAGE_BUCKET: z.string().min(1),
  TASKS_QUEUE: z.string().min(1),
  WORKER_URL: z.string().url(),
  GMAIL_CLIENT_ID: z.string().min(1),
  GMAIL_CLIENT_SECRET: z.string().min(1),
  GMAIL_REFRESH_TOKEN: z.string().min(1),
  DAILY_TEMPLATE_ID: z.string().min(1),
  INVOICE_DETAIL_TEMPLATE_ID: z.string().min(1),
  INVOICE_COVER_TEMPLATE_ID: z.string().min(1),
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
  SENTRY_DSN: z.string().url().optional(),
  JOB_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .refine((v) => v === 5, { message: 'JOB_MAX_ATTEMPTSは5固定（環境変数完全台帳準拠）' })
    .default(5),
  SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .refine((v) => v === 600, { message: 'SIGNED_URL_TTL_SECONDSは600固定（環境変数完全台帳準拠）' })
    .default(600),
  TZ: z.literal('UTC').default('UTC'),
  BUSINESS_TIMEZONE: z.literal('Asia/Tokyo').default('Asia/Tokyo'),
  BILLING_ALGORITHM_VERSION: z.string().min(1).default('BILL-2026-09-05'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`環境変数の検証に失敗しました: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCacheForTest(): void {
  cached = undefined;
}
EOF

cat > packages/config/src/index.ts << 'EOF'
export * from './env';
EOF

cat > packages/config/src/env.test.ts << 'EOF'
import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnv, resetEnvCacheForTest } from './env';

const BASE_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'dev',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  APP_ORIGIN: 'https://inspexor-web-example.run.app',
  STORAGE_BUCKET: 'inspexor-dev-bucket',
  TASKS_QUEUE: 'inspexor-dev-queue',
  WORKER_URL: 'https://inspexor-worker-example.run.app',
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_REFRESH_TOKEN: 'refresh-token',
  DAILY_TEMPLATE_ID: 'tmpl-daily',
  INVOICE_DETAIL_TEMPLATE_ID: 'tmpl-invoice-detail',
  INVOICE_COVER_TEMPLATE_ID: 'tmpl-invoice-cover',
};

describe('env: インフラ・運用設計書 §9 環境変数完全台帳 準拠', () => {
  beforeEach(() => {
    resetEnvCacheForTest();
  });

  it('必須項目が揃っていれば既定値込みでparseされる', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.JOB_MAX_ATTEMPTS).toBe(5);
    expect(env.SIGNED_URL_TTL_SECONDS).toBe(600);
    expect(env.TZ).toBe('UTC');
    expect(env.BUSINESS_TIMEZONE).toBe('Asia/Tokyo');
    expect(env.BILLING_ALGORITHM_VERSION).toBe('BILL-2026-09-05');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('必須項目が欠落していると例外', () => {
    const broken = { ...BASE_ENV };
    delete (broken as Record<string, unknown>).AUTH_SECRET;
    expect(() => loadEnv(broken)).toThrow();
  });

  it('JOB_MAX_ATTEMPTSが5以外なら例外（台帳の固定値制約）', () => {
    const broken = { ...BASE_ENV, JOB_MAX_ATTEMPTS: '3' };
    expect(() => loadEnv(broken)).toThrow();
  });
});
EOF

# ============================================================
# 11. 依存追加（config配下にzod/vitest/typescriptを明示依存化）
# ============================================================
cd packages/config
pnpm add zod@^3.23.8
pnpm add -D vitest@^2.1.3 typescript@^5.6.3
cd ~/inspexor

pnpm install

# ============================================================
# 12. 型検査とテスト実行
# ============================================================
echo "=== domain: tsc --noEmit ==="
(cd packages/domain && npx tsc --noEmit)

echo "=== domain: vitest run ==="
(cd packages/domain && npx vitest run)

echo "=== config: tsc --noEmit ==="
(cd packages/config && npx tsc --noEmit)

echo "=== config: vitest run ==="
(cd packages/config && npx vitest run)
