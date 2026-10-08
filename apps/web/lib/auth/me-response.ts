export interface MeData {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export type MeOutcome =
  | { readonly kind: 'authenticated'; readonly data: MeData }
  | { readonly kind: 'unauthenticated' };

function isMeDataBody(value: unknown): value is { data: MeData } {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    return false;
  }
  const data = (value as { data: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['roles'])
  );
}

export function interpretMeResponse(status: number, body: unknown): MeOutcome {
  if (status === 200 && isMeDataBody(body)) {
    return { kind: 'authenticated', data: body.data };
  }
  return { kind: 'unauthenticated' };
}
