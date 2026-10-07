import { handleLogoutRequest } from '../../../../lib/auth/logout-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLogoutRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
