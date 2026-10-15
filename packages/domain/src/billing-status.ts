/**
 * INSPEXOR_システム基本設計書_v5.1.md §状態遷移（Billing行）準拠。
 *
 * CHG-009 で次を追加した（設計書に記載が無かった遷移）:
 *  - 再計算: CALCULATED / NEEDS_REVIEW / REVIEWED → calculate → CALCULATING（仕様書「再計算は新calc_versionで旧結果を保持」）
 *  - 取消: OPEN / CALCULATED / NEEDS_REVIEW / REVIEWED → void → VOIDED（確定前の請求 run の取消。理由必須）
 *    確定後（FINALIZED 以降）の無効化は請求書の無効化（API-023 void）で扱う
 * CHG-011: FINALIZED / ISSUED / SENT → void → VOIDED（請求書の無効化と同時。理由必須。報告は承認済みに戻り、同じ期間を作り直せる）
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

/** CHG-009 で VOIDED の遷移を定義したため空 */
export const UNDOCUMENTED_BILLING_STATES: readonly BillingStatus[] = [] as const;

export type BillingRole = 'OFFICE' | 'ADMIN' | 'SYSTEM';

export type BillingCommand = 'calculate' | 'complete' | 'review' | 'finalize' | 'issue' | 'mailSent' | 'void';

export interface BillingTransitionRule {
  readonly from: BillingStatus;
  readonly command: BillingCommand;
  readonly to: BillingStatus | { readonly withWarnings: BillingStatus; readonly withoutWarnings: BillingStatus };
  readonly allowedRoles: readonly BillingRole[];
  readonly guardNote: string;
}

export const BILLING_TRANSITIONS: readonly BillingTransitionRule[] = [
  { from: 'OPEN', command: 'calculate', to: 'CALCULATING', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'period unique' },
  { from: 'CALCULATED', command: 'calculate', to: 'CALCULATING', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 再計算（新calc_version）' },
  { from: 'NEEDS_REVIEW', command: 'calculate', to: 'CALCULATING', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 再計算（新calc_version）' },
  { from: 'REVIEWED', command: 'calculate', to: 'CALCULATING', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 再計算（新calc_version）' },
  { from: 'CALCULATING', command: 'complete', to: { withWarnings: 'NEEDS_REVIEW', withoutWarnings: 'CALCULATED' }, allowedRoles: ['SYSTEM'], guardNote: 'warning有無' },
  { from: 'NEEDS_REVIEW', command: 'review', to: 'REVIEWED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: '全warning disposition' },
  { from: 'CALCULATED', command: 'finalize', to: 'FINALIZED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'source versions一致' },
  { from: 'REVIEWED', command: 'finalize', to: 'FINALIZED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'source versions一致' },
  { from: 'FINALIZED', command: 'issue', to: 'ISSUED', allowedRoles: ['SYSTEM'], guardNote: 'PDF hash有' },
  { from: 'ISSUED', command: 'mailSent', to: 'SENT', allowedRoles: ['SYSTEM'], guardNote: 'provider id有' },
  { from: 'OPEN', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 確定前の取消、理由必須' },
  { from: 'CALCULATED', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 確定前の取消、理由必須' },
  { from: 'NEEDS_REVIEW', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 確定前の取消、理由必須' },
  { from: 'REVIEWED', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-009 確定前の取消、理由必須' },
  { from: 'FINALIZED', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-011 請求書の無効化、理由必須' },
  { from: 'ISSUED', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-011 請求書の無効化、理由必須' },
  { from: 'SENT', command: 'void', to: 'VOIDED', allowedRoles: ['OFFICE', 'ADMIN'], guardNote: 'CHG-011 請求書の無効化、理由必須' },
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
