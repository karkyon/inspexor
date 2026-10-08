/**
 * audit_events（DB設計書 #34、append-only / 7年）への書込port。
 * secret・request body全文は保存しない（API設計書 監査列、SEC-017）。
 */
export interface AuditRecord {
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeData?: unknown;
  readonly afterData?: unknown;
  readonly reason?: string;
  readonly correlationId: string;
  readonly occurredAt?: Date;
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<string>;
}
