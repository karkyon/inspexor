/**
 * outbox dispatcher（機能別詳細設計書 §job）: PENDING を SKIP LOCKED で取得し、consumer の job を作って DISPATCHED にする。
 * 開発環境では Cloud Tasks の代わりに document_jobs への登録が「enqueue」（G4 範囲決定: 開発環境で全経路）。
 * job の冪等 key は確定 revision 単位なので、同じ event を二度処理しても job は1件（at-least-once 前提）。
 */
import { withTransaction, type Pool, type PoolClient } from './db';
import { createDailyMailJob } from './mail-jobs';
import { workSnapshot } from './templates';

export const DOCUMENT_EVENT_TEMPLATE: Readonly<Record<string, { template: string; documentType: string; sourceType: string }>> = {
  WorkReportConfirmed: { template: 'DAILY_REPORT_V1', documentType: 'DAILY_REPORT', sourceType: 'WORK_REVISION' },
  DeliveryReportConfirmed: { template: 'DELIVERY_REPORT_V1', documentType: 'DELIVERY_REPORT', sourceType: 'DELIVERY_REVISION' },
};

export function autoDocumentKey(template: string, revisionId: string): string {
  return `DOC:${template}:${revisionId}:auto`;
}

/** available_at は DB の now() で書かれるため、判定も DB 時刻で行う（_now は呼出側の時計、記録用に受けるのみ） */
export async function dispatchOutbox(pool: Pool, _now: Date, limit = 20): Promise<number> {
  return withTransaction(pool, async (client) => {
    const r = await client.query<{ id: string; event_type: string; payload: { payload?: { revisionId?: string } } }>(
      `SELECT id, event_type, payload FROM app.outbox_events
        WHERE status = 'PENDING' AND available_at <= now()
        ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const ev of r.rows) {
      const route = DOCUMENT_EVENT_TEMPLATE[ev.event_type];
      const revisionId = ev.payload?.payload?.revisionId;
      if (route !== undefined && typeof revisionId === 'string') {
        await client.query(
          `INSERT INTO app.document_jobs (document_type, source_type, source_id, template_version, idempotency_key)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
          [route.documentType, route.sourceType, revisionId, route.template, autoDocumentKey(route.template, revisionId)],
        );
      }
      if (ev.event_type === 'DocumentRequested') await onDocumentRequested(client, ev.id, ev.payload?.payload as Record<string, unknown> | undefined);
      if (ev.event_type === 'MailRequested') await onMailRequested(client, ev.id, ev.payload?.payload as Record<string, unknown> | undefined);
      // G4 時点で consumer の無い event（RecordSubmitted 等）は配送済みとして扱う（後続 Gate で consumer 追加）
      await client.query(`UPDATE app.outbox_events SET status = 'DISPATCHED', attempts = attempts + 1 WHERE id = $1`, [ev.id]);
    }
    return r.rows.length;
  });
}

/** API-025 regenerate / retry（帳票）: 同じ確定 revision に新しい帳票 job（旧版は保持）。key は event 単位で冪等 */
async function onDocumentRequested(client: PoolClient, eventId: string, p: Record<string, unknown> | undefined): Promise<void> {
  if (p === undefined || typeof p['revisionId'] !== 'string' || typeof p['template'] !== 'string') return;
  await client.query(
    `INSERT INTO app.document_jobs (document_type, source_type, source_id, template_version, idempotency_key)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
    [p['documentType'], p['sourceType'], p['revisionId'], p['template'], `DOC:${p['template']}:${p['revisionId']}:${String(p['mode'])}:${eventId}`],
  );
}

/** API-025 send / retry（メール）: 生成済み日報を新しい mail job で送る（send_revision+1、宛先は現時点の snapshot） */
async function onMailRequested(client: PoolClient, eventId: string, p: Record<string, unknown> | undefined): Promise<void> {
  if (p === undefined || typeof p['documentJobId'] !== 'string') return;
  const doc = await client.query<{ source_id: string; source_type: string; storage_key: string | null }>(
    `SELECT d.source_id, d.source_type, f.storage_key FROM app.document_jobs d LEFT JOIN app.files f ON f.id = d.file_id WHERE d.id = $1 AND d.status = 'GENERATED'`,
    [p['documentJobId']],
  );
  const d = doc.rows[0];
  if (d === undefined || d.source_type !== 'WORK_REVISION' || d.storage_key === null) return;
  const snapshot = await workSnapshot(client, d.source_id);
  if (snapshot === null) return;
  const max = await client.query<{ n: number | null }>('SELECT max(send_revision) AS n FROM app.mail_jobs WHERE document_job_id = $1', [p['documentJobId']]);
  await createDailyMailJob(
    client,
    {
      documentJobId: p['documentJobId'] as string,
      snapshot,
      fileName: d.storage_key.split('/').pop() as string,
      sendRevision: (max.rows[0]?.n ?? 0) + 1,
      reason: null,
      idempotencyKey: `MAIL:DAILY_REPORT:${p['documentJobId'] as string}:req:${eventId}`,
    },
    new Date(),
  );
}
