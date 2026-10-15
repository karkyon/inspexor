/**
 * 提案書（SK-2026-08-MINI）の対象外機能の有効化設定（CHG-004 Blind・CHG-007）。
 * 実装はあるが既定で無効。環境変数が文字列 'true' のときだけ有効にする（本番は既定で無効）。
 *   APPROVAL_ENABLED    承認ワークフロー（承認・差戻し・取消）と管理ダッシュボード（FR-007・FR-017、SCR-10/12）
 *   BILLING_ENABLED     請求計算・請求書（FR-009〜014・FR-019、SCR-14/15）。承認済みの実績が対象のため APPROVAL_ENABLED も必要
 *   DAILY_MAIL_ENABLED  日報メール自動送信（FR-006）
 *   ADMIN_MFA_ENABLED   CHG-012 管理者の多要素認証（SEC-004）。提案書の「固定利用者認証」に加える安全対策のため、お客様の合意後に有効にする
 */
export interface FeatureFlags {
  readonly approval: boolean;
  readonly billing: boolean;
  readonly dailyMail: boolean;
  readonly adminMfa: boolean;
}

const on = (value: string | undefined): boolean => value === 'true';

export function featureFlags(env: Readonly<Record<string, string | undefined>>): FeatureFlags {
  const approval = on(env['APPROVAL_ENABLED']);
  return { approval, billing: approval && on(env['BILLING_ENABLED']), dailyMail: on(env['DAILY_MAIL_ENABLED']), adminMfa: on(env['ADMIN_MFA_ENABLED']) };
}
