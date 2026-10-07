export const SESSION_COOKIE_NAME = 'inspexor_session';

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) {
      return rawValueParts.join('=');
    }
  }
  return null;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
