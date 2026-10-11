/**
 * RBAC（ロール別アクセス制御）方針表。INSPEXOR_API・イベント設計書_v5.1.md §6 Endpoint完全契約の
 * 「認証/権限」「冪等性」列をそのまま写したもの。値の推測・追加はしない。
 *
 *  - PUBLIC         : 未認証可（API-001）
 *  - AUTHENTICATED  : 認証済みなら可。"AUTH" / "scoped" / "AUTH scoped" はここ。
 *                     対象データの絞込み（SEC-006 IDOR対策）は repository query 側で必ず行う。
 *  - ROLES          : 列挙ロールのみ可。ownerAllowed=true は "owner/OFFICE" 型で、
 *                     ロール外でも所有者なら可（所有者判定は対象読込後に repository で行う）。
 *
 * GAP-011: API-013 transitionRecord は設計書で冪等性 yes だが、openapi.yaml の
 *          /records/{type}/{id}/{action} には Idempotency-Key parameter が無い。
 *          本表は設計書どおり idempotent=true とし、contract test で既知差分として明示する。
 */

export type RoleCode = 'FIELD' | 'OFFICE' | 'ADMIN' | 'AUDITOR';

export const ROLE_CODES: readonly RoleCode[] = ['FIELD', 'OFFICE', 'ADMIN', 'AUDITOR'];

export function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}

export type AccessRule =
  | { readonly kind: 'PUBLIC' }
  | { readonly kind: 'AUTHENTICATED' }
  | { readonly kind: 'ROLES'; readonly roles: readonly RoleCode[]; readonly ownerAllowed: boolean };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface OperationPolicy {
  readonly apiId: string;
  readonly method: HttpMethod;
  /** openapi paths のキー（base /api/v1 を除く） */
  readonly path: string;
  readonly access: AccessRule;
  readonly idempotent: boolean;
}

const PUBLIC: AccessRule = { kind: 'PUBLIC' };
const AUTHENTICATED: AccessRule = { kind: 'AUTHENTICATED' };
const roles = (list: readonly RoleCode[], ownerAllowed = false): AccessRule => ({
  kind: 'ROLES',
  roles: list,
  ownerAllowed,
});

export const OPERATION_POLICIES = {
  login: { apiId: 'API-001', method: 'POST', path: '/auth/login', access: PUBLIC, idempotent: false },
  logout: { apiId: 'API-002', method: 'POST', path: '/auth/logout', access: AUTHENTICATED, idempotent: false },
  getMe: { apiId: 'API-003', method: 'GET', path: '/me', access: AUTHENTICATED, idempotent: false },
  createWorkReport: { apiId: 'API-004', method: 'POST', path: '/work-reports', access: roles(['FIELD', 'OFFICE']), idempotent: false },
  getWorkReport: { apiId: 'API-005', method: 'GET', path: '/work-reports/{id}', access: AUTHENTICATED, idempotent: false },
  updateWorkReport: { apiId: 'API-006', method: 'PATCH', path: '/work-reports/{id}', access: roles(['OFFICE'], true), idempotent: false },
  confirmWorkReport: { apiId: 'API-007', method: 'POST', path: '/work-reports/{id}/confirm', access: roles(['OFFICE'], true), idempotent: true },
  createDeliveryReport: { apiId: 'API-008', method: 'POST', path: '/delivery-reports', access: roles(['FIELD', 'OFFICE']), idempotent: false },
  getDeliveryReport: { apiId: 'API-009', method: 'GET', path: '/delivery-reports/{id}', access: AUTHENTICATED, idempotent: false },
  updateDeliveryReport: { apiId: 'API-010', method: 'PATCH', path: '/delivery-reports/{id}', access: roles(['OFFICE'], true), idempotent: false },
  confirmDeliveryReport: { apiId: 'API-011', method: 'POST', path: '/delivery-reports/{id}/confirm', access: roles(['OFFICE'], true), idempotent: true },
  // CHG-002: FIELD を追加（業務要件 §2「自分の履歴 FIELD=R」）。FIELD は repository で owner=本人に限定する
  listRecords: { apiId: 'API-012', method: 'GET', path: '/records', access: roles(['FIELD', 'OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  // CHG-007: owner は差戻し（REJECTED）・取消（REVOKED）された自分の報告の revise のみ可（システム基本設計書 §状態遷移 REJECTED/REVOKED→revise owner）。
  // owner 判定と操作の制限は handler / service で行う
  transitionRecord: { apiId: 'API-013', method: 'POST', path: '/records/{type}/{id}/{action}', access: roles(['OFFICE', 'ADMIN'], true), idempotent: true },
  listMasters: { apiId: 'API-014', method: 'GET', path: '/masters/{type}', access: AUTHENTICATED, idempotent: false },
  createMaster: { apiId: 'API-015', method: 'POST', path: '/masters/{type}', access: roles(['ADMIN']), idempotent: false },
  getMaster: { apiId: 'API-016', method: 'GET', path: '/masters/{type}/{id}', access: AUTHENTICATED, idempotent: false },
  updateMaster: { apiId: 'API-017', method: 'PATCH', path: '/masters/{type}/{id}', access: roles(['ADMIN']), idempotent: false },
  deactivateMaster: { apiId: 'API-018', method: 'DELETE', path: '/masters/{type}/{id}', access: roles(['ADMIN']), idempotent: false },
  createBillingRun: { apiId: 'API-019', method: 'POST', path: '/billing-runs', access: roles(['OFFICE', 'ADMIN']), idempotent: true },
  getBillingRun: { apiId: 'API-020', method: 'GET', path: '/billing-runs/{id}', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  transitionBillingRun: { apiId: 'API-021', method: 'POST', path: '/billing-runs/{id}/{action}', access: roles(['OFFICE', 'ADMIN']), idempotent: true },
  getInvoice: { apiId: 'API-022', method: 'GET', path: '/invoices/{id}', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  transitionInvoice: { apiId: 'API-023', method: 'POST', path: '/invoices/{id}/{action}', access: roles(['OFFICE', 'ADMIN']), idempotent: true },
  getDocument: { apiId: 'API-024', method: 'GET', path: '/documents/{id}', access: AUTHENTICATED, idempotent: false },
  documentAction: { apiId: 'API-025', method: 'POST', path: '/documents/{id}/{action}', access: roles(['OFFICE', 'ADMIN']), idempotent: true },
  // CHG-004 D2: 運搬費の後入力（事務所）
  setDeliveryFee: { apiId: 'API-026', method: 'POST', path: '/delivery-reports/{id}/fee', access: roles(['OFFICE', 'ADMIN']), idempotent: false },
  // CHG-004 D4: 月次集計と Excel/CSV 出力（AUDITOR は download を含む参照可: 業務要件 §2）
  getMonthlySummary: { apiId: 'API-027', method: 'GET', path: '/reports/monthly', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  exportMonthlySummary: { apiId: 'API-028', method: 'GET', path: '/reports/monthly/export', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  // CHG-007: 管理ダッシュボード（SCR-10、FR-017）。APPROVAL_ENABLED のときだけ提供
  getDashboard: { apiId: 'API-029', method: 'GET', path: '/dashboard', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  // CHG-008: 利用者管理（業務要件 §2 RBAC「master/user: ADMIN=CRUD、OFFICE/AUDITOR=R」）
  listUsers: { apiId: 'API-030', method: 'GET', path: '/users', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
  createUser: { apiId: 'API-031', method: 'POST', path: '/users', access: roles(['ADMIN']), idempotent: false },
  updateUser: { apiId: 'API-032', method: 'PATCH', path: '/users/{id}', access: roles(['ADMIN']), idempotent: false },
  userAction: { apiId: 'API-033', method: 'POST', path: '/users/{id}/{action}', access: roles(['ADMIN']), idempotent: false },
  // CHG-009: 請求 run の一覧（SCR-14）。BILLING_ENABLED のときだけ提供
  listBillingRuns: { apiId: 'API-034', method: 'GET', path: '/billing-runs', access: roles(['OFFICE', 'ADMIN', 'AUDITOR']), idempotent: false },
} as const satisfies Record<string, OperationPolicy>;

export type OperationId = keyof typeof OPERATION_POLICIES;

export const KNOWN_IDEMPOTENCY_GAPS: readonly OperationId[] = ['transitionRecord'];

export interface AuthorizationActor {
  readonly roles: readonly RoleCode[];
}

export type AuthorizationResult =
  | { readonly ok: true; readonly ownerCheckRequired: boolean }
  | { readonly ok: false; readonly errorCode: 'AUTH_REQUIRED' | 'FORBIDDEN' };

/**
 * 認証後・対象読込前の事前認可。actor=null は未認証。
 * ownerCheckRequired=true の場合、呼出側は対象読込後に所有者でなければ FORBIDDEN を返すこと。
 */
export function authorizeOperation(operationId: OperationId, actor: AuthorizationActor | null): AuthorizationResult {
  const policy: OperationPolicy = OPERATION_POLICIES[operationId];
  const access = policy.access;
  if (access.kind === 'PUBLIC') {
    return { ok: true, ownerCheckRequired: false };
  }
  if (actor === null) {
    return { ok: false, errorCode: 'AUTH_REQUIRED' };
  }
  if (access.kind === 'AUTHENTICATED') {
    return { ok: true, ownerCheckRequired: false };
  }
  if (actor.roles.some((role) => access.roles.includes(role))) {
    return { ok: true, ownerCheckRequired: false };
  }
  if (access.ownerAllowed) {
    return { ok: true, ownerCheckRequired: true };
  }
  return { ok: false, errorCode: 'FORBIDDEN' };
}
