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
