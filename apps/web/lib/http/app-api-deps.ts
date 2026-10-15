/**
 * アプリ（本番・開発）の API 入口の共通設定: session 署名鍵・監査・利用者の有効確認（CHG-008・CHG-012 多要素認証）・回数制限（CHG-012）
 */
import { StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { appUserGuard } from '../auth/app-user-guard';
import { MemoryRateLimiter } from '../security/rate-limit';
import type { ApiHandlerDeps } from './api-handler';

const limiter = new MemoryRateLimiter();

export function appApiDeps(): ApiHandlerDeps {
  return {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    auditRepository: new StoreAuditRepository(getDocStore()),
    userGuard: appUserGuard,
    rateLimiter: limiter,
  };
}
