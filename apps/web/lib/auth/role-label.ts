/** K-03: 区分（ロール）の画面表示。要件定義書 3.1 の名称（現場・事務所・管理者・監査）で表示する */
export const ROLE_LABEL: Readonly<Record<string, string>> = { FIELD: '現場', OFFICE: '事務所', ADMIN: '管理者', AUDITOR: '監査' };

/** 区分の並びはそのまま、名称を「・」でつなぐ（未定義の値はそのまま表示） */
export function roleText(roles: readonly string[]): string {
  return roles.map((r) => ROLE_LABEL[r] ?? r).join('・');
}
