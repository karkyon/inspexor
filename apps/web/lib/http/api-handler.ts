/**
 * 全API共通の入口。ADR-0001 / 00契約 不変条件2 の前半（認証 → CSRF → 認可）と
 * 冪等性ヘッダ検査をここで行い、Zod/version/state/業務制約は各handler（command pipeline）で行う。
 *
 *  1. correlationId 解決（uuid）
 *  2. 認証: session cookie → 署名検証 → idle/absolute期限（SEC-001）。未認証 401 AUTH_REQUIRED
 *  3. CSRF: GET以外は X-CSRF-Token 必須（SEC-005）。403 CSRF_INVALID
 *  4. 認可: OPERATION_POLICIES（RBAC）。403 FORBIDDEN、拒否は audit に記録（API設計書 監査列）
 *  5. 冪等性: idempotent operation は Idempotency-Key 16–100字必須。422 VALIDATION_ERROR
 *  6. handler 実行。未捕捉例外は 500 INTERNAL_ERROR（詳細は返さない、SEC-010）
 *  7. 成功時は session の lastActivityAt を更新した cookie を再発行（操作中の idle timeout 防止）
 */
import {
  OPERATION_POLICIES,
  authorizeOperation,
  checkSessionValidity,
  isRoleCode,
  sessionCookieAttributes,
  type OperationId,
  type RoleCode,
} from '@inspexor/domain';
import type { AuditRepository } from '@inspexor/application';
import { verifyCsrfToken } from '../security/csrf';
import { readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from '../auth/session-cookie';
import { verifySessionToken, issueSessionToken, refreshLastActivity, type SessionPayload } from '../auth/session-token';
import { resolveCorrelationId } from './correlation-id';
import { errorResponse } from './api-response';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 100;

export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly roles: readonly RoleCode[];
}

export interface ApiContext {
  readonly request: Request;
  readonly operationId: OperationId;
  readonly correlationId: string;
  /** PUBLIC operation の場合のみ null */
  readonly actor: Actor | null;
  /** true の場合、handler は対象読込後に所有者でなければ FORBIDDEN を返すこと（owner/OFFICE型） */
  readonly ownerCheckRequired: boolean;
  /** idempotent operation の場合のみ値が入る */
  readonly idempotencyKey: string | null;
  readonly now: Date;
}

export interface ApiHandlerDeps {
  readonly sessionSecret: string;
  readonly now: () => Date;
  readonly auditRepository: AuditRepository;
  readonly logError?: (message: string, detail: unknown) => void;
  /** CHG-008: セッションの利用者が今も有効か（無効化・ロール変更・パスワード再設定後は false）。未指定なら確認しない（試験） */
  readonly userGuard?: (session: SessionPayload) => Promise<boolean>;
}

export type ApiHandler = (ctx: ApiContext) => Promise<Response>;

function toActor(payload: SessionPayload): Actor {
  return {
    userId: payload.userId,
    sessionId: payload.sessionId,
    displayName: payload.displayName,
    roles: payload.roles.filter(isRoleCode),
  };
}

export function createApiHandler(
  operationId: OperationId,
  handler: ApiHandler,
  resolveDeps: () => ApiHandlerDeps,
): (request: Request) => Promise<Response> {
  const policy = OPERATION_POLICIES[operationId];

  return async (request: Request): Promise<Response> => {
    const correlationId = resolveCorrelationId(request);
    let deps: ApiHandlerDeps;
    try {
      deps = resolveDeps();
    } catch {
      return errorResponse(500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました。', correlationId, { retryable: true });
    }
    const now = deps.now();
    const logError = deps.logError ?? ((message: string, detail: unknown) => console.error(message, detail));

    // ---- 2. 認証 ----
    let session: SessionPayload | null = null;
    if (policy.access.kind !== 'PUBLIC') {
      const token = readSessionCookie(request);
      const payload = token ? verifySessionToken(token, deps.sessionSecret) : null;
      const valid =
        payload !== null &&
        checkSessionValidity(
          { issuedAt: new Date(payload.issuedAt), lastActivityAt: new Date(payload.lastActivityAt) },
          now,
        ).valid;
      if (!valid || payload === null) {
        return errorResponse(401, 'AUTH_REQUIRED', '認証が必要です。', correlationId, {
          setCookie: clearSessionCookieHeader(),
        });
      }
      if (deps.userGuard !== undefined && !(await deps.userGuard(payload))) {
        return errorResponse(401, 'AUTH_REQUIRED', '認証が必要です。', correlationId, {
          setCookie: clearSessionCookieHeader(),
        });
      }
      session = payload;

      // ---- 3. CSRF（state-changing のみ） ----
      if (request.method.toUpperCase() !== 'GET') {
        const csrfToken = request.headers.get('x-csrf-token');
        if (!csrfToken || !verifyCsrfToken(csrfToken, payload.sessionId, deps.sessionSecret)) {
          return errorResponse(403, 'CSRF_INVALID', 'CSRFトークンが無効です。', correlationId);
        }
      }
    }
    const actor = session !== null ? toActor(session) : null;

    // ---- 4. 認可 ----
    const authz = authorizeOperation(operationId, actor);
    if (!authz.ok) {
      if (authz.errorCode === 'FORBIDDEN' && actor !== null) {
        try {
          await deps.auditRepository.append({
            actorId: actor.userId,
            action: 'AUTHZ_DENIED',
            // audit_events.target_id は uuid NOT NULL のため、操作対象未特定の拒否は actor 自身を target とする
            targetType: 'USER',
            targetId: actor.userId,
            afterData: { operationId, apiId: policy.apiId, method: request.method, roles: actor.roles },
            correlationId,
            occurredAt: now,
          });
        } catch (error) {
          logError('audit append failed (AUTHZ_DENIED)', { correlationId, error: String(error) });
        }
        return errorResponse(403, 'FORBIDDEN', 'この操作を行う権限がありません。', correlationId);
      }
      return errorResponse(401, 'AUTH_REQUIRED', '認証が必要です。', correlationId);
    }

    // ---- 5. 冪等性ヘッダ ----
    let idempotencyKey: string | null = null;
    if (policy.idempotent) {
      const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      if (key === null || key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
        return errorResponse(422, 'VALIDATION_ERROR', 'Idempotency-Key ヘッダは16〜100文字で必須です。', correlationId, {
          fields: [
            {
              path: '/headers/Idempotency-Key',
              code: key === null ? 'required' : 'length',
              message: 'Idempotency-Key ヘッダは16〜100文字で必須です。',
            },
          ],
        });
      }
      idempotencyKey = key;
    }

    // ---- 6. handler ----
    let response: Response;
    try {
      response = await handler({
        request,
        operationId,
        correlationId,
        actor,
        ownerCheckRequired: authz.ownerCheckRequired,
        idempotencyKey,
        now,
      });
    } catch (error) {
      logError('unhandled api error', { correlationId, operationId, error: String(error) });
      return errorResponse(500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました。', correlationId, { retryable: true });
    }

    // ---- 7. session延長 ----
    if (session !== null && response.status < 400) {
      const refreshed = issueSessionToken(refreshLastActivity(session, now), deps.sessionSecret);
      response.headers.append('Set-Cookie', sessionCookieHeader(refreshed, sessionCookieAttributes().maxAge));
    }
    if (!response.headers.has('x-correlation-id')) {
      response.headers.set('x-correlation-id', correlationId);
    }
    return response;
  };
}
