import { handleMfaVerify } from '../../../../../../lib/auth/mfa-handlers';
import { mfaPublicDeps } from '../../../../../../lib/auth/mfa-route-deps';

export const dynamic = 'force-dynamic';

// CHG-012 API-039
export async function POST(request: Request): Promise<Response> {
  return handleMfaVerify(request, mfaPublicDeps);
}
