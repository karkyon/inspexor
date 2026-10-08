import { handleMeRequest } from '../../../../lib/auth/me-handler';
import { getSessionSecret } from '../../../../lib/auth/session-secret';

export async function GET(request: Request): Promise<Response> {
  return handleMeRequest(request, {
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
