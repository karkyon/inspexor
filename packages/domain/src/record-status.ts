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
  | 'billingFinalize'
  | 'billingUnlock';

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
  // CHG-011: 請求書の無効化（理由必須）で、その請求に入っていた報告を承認済みに戻す（同じ期間を作り直すため）
  { from: 'BILLING_LOCKED', command: 'billingUnlock', to: 'APPROVED', ownerAllowed: false, allowedRoles: ['SYSTEM'], reasonRequired: false, guardNote: 'CHG-011 invoice void' },
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
