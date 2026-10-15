/** CHG-012 SEC-026: 直近 REAUTH_WINDOW_MINUTES 分以内に認証していなければ 403（reauthRequired）を返す */
import { isRecentAuth, REAUTH_WINDOW_MINUTES } from '@inspexor/domain';
import type { ApiContext } from '../http/api-handler';
import { errorResponse } from '../http/api-response';

export function reauthRequiredResponse(ctx: ApiContext): Response | null {
  if (ctx.actor === null || isRecentAuth(ctx.actor.authAt, ctx.now)) return null;
  return errorResponse(403, 'FORBIDDEN', `この操作の前に、パスワードをもう一度入力してください（${REAUTH_WINDOW_MINUTES}分間有効）。`, ctx.correlationId, { extra: { reauthRequired: true } });
}
