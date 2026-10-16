/**
 * CHG-013 試験データの後片付け（T5 現場テストなどで本番に入れた試験用データを、実運用の前に取り除く）。
 *
 *  対象: お客様コードが接頭辞（既定 TEST-）で始まるお客様の、作業日報・運搬実績（版・帳票の依頼・ファイルの記録・送信の依頼・イベントを含む）
 *  後片付けの内容:
 *    1. 上の報告を削除する（請求確定済み BILLING_LOCKED の報告がある場合は中止）
 *    2. 接頭辞で始まるお客様・作業者・車両・作業場所と、そのお客様の品番・作業内容・不良種別・担当者を無効化する（記録は残る）
 *    3. 指定があれば、ログインIDが接頭辞（例 test.）で始まる利用者を利用停止にする
 *  変更の記録（監査）は消さない。後片付けそのものも1件の記録（TEST_DATA_PURGE）として残す
 *  帳票の PDF（Cloud Storage）は、このスクリプトでは消さない。保存先のキーを返すので、手順書のコマンドで消す
 *  確認（apply=false）では何も変えず、件数だけ返す
 */
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  C,
  REPORT_COLLECTION,
  revisionCollection,
  type DocStore,
  type DocumentJobDoc,
  type ReportHeaderDoc,
  type UserDoc,
} from '@inspexor/docstore';
import { MasterService } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { invalidateUserGuard } from '../auth/user-guard';

export interface PurgeOptions {
  readonly prefix: string;
  /** 利用者のログインIDの接頭辞（空なら利用者は変えない） */
  readonly userPrefix: string;
  readonly apply: boolean;
  readonly actorId: string;
  readonly reason: string;
  readonly now: Date;
}

export interface PurgeResult {
  readonly applied: boolean;
  readonly customers: readonly string[];
  readonly reports: { readonly work: number; readonly delivery: number };
  readonly deletedDocs: number;
  readonly storageKeys: readonly string[];
  readonly deactivated: Readonly<Record<string, number>>;
  readonly users: readonly string[];
}

export async function purgeTestData(store: DocStore, opts: PurgeOptions): Promise<PurgeResult> {
  const prefix = opts.prefix.trim();
  if (prefix.length < 3) throw new Error('接頭辞は3文字以上にしてください（例 TEST-）。');
  const customers = (await store.query<Record<string, unknown>>(C.customers)).filter((c) => String(c.data['code']).startsWith(prefix));
  const customerIds = new Set(customers.map((c) => c.id));

  // ---- 1. 報告と関連の文書
  const paths: string[] = [];
  const storageKeys: string[] = [];
  const counts = { work: 0, delivery: 0 };
  for (const type of ['WORK', 'DELIVERY'] as const) {
    for (const cid of customerIds) {
      const headers = await store.query<ReportHeaderDoc>(REPORT_COLLECTION[type], { where: [{ field: 'customerId', op: '==', value: cid }] });
      for (const h of headers) {
        if (h.data.status === 'BILLING_LOCKED') throw new Error(`請求確定済みの報告（${h.data.reportNo}）があるため中止しました。先に請求書を無効化してください。`);
        counts[type === 'WORK' ? 'work' : 'delivery'] += 1;
        paths.push(`${REPORT_COLLECTION[type]}/${h.id}`);
        for (const r of await store.query(revisionCollection(type, h.id))) paths.push(`${revisionCollection(type, h.id)}/${r.id}`);
        const docs = await store.query<DocumentJobDoc>(C.documents, { where: [{ field: 'reportId', op: '==', value: h.id }] });
        for (const d of docs) {
          paths.push(`${C.documents}/${d.id}`);
          if (d.data.fileId !== null) {
            const f = await store.get<{ storageKey: string }>(`${C.files}/${d.data.fileId}`);
            if (f !== null) {
              paths.push(`${C.files}/${d.data.fileId}`);
              storageKeys.push(f.storageKey);
            }
          }
          for (const m of await store.query(C.mailJobs, { where: [{ field: 'documentJobId', op: '==', value: d.id }] })) paths.push(`${C.mailJobs}/${m.id}`);
        }
        for (const o of await store.query(C.outbox, { where: [{ field: 'aggregateId', op: '==', value: h.id }] })) paths.push(`${C.outbox}/${o.id}`);
      }
    }
  }

  // ---- 2. 無効化するマスタ
  const deact: Array<{ type: MasterType; id: string; version: number }> = [];
  const add = (type: MasterType, rows: Array<{ id: string; data: Record<string, unknown> }>) => {
    for (const r of rows) if (r.data['active'] !== false) deact.push({ type, id: r.id, version: Number(r.data['version']) });
  };
  add('customers', customers);
  for (const cid of customerIds) {
    const products = await store.query<Record<string, unknown>>(C.products, { where: [{ field: 'customerId', op: '==', value: cid }] });
    add('products', products);
    add('contacts', await store.query<Record<string, unknown>>(C.customerContacts, { where: [{ field: 'customerId', op: '==', value: cid }] }));
    for (const p of products) {
      add('work-types', await store.query<Record<string, unknown>>(C.workTypes, { where: [{ field: 'productId', op: '==', value: p.id }] }));
      add('defects', await store.query<Record<string, unknown>>(C.defectTypes, { where: [{ field: 'productId', op: '==', value: p.id }] }));
      for (const t of ['rates', 'transport-rules', 'fixed-charges'] as const) add(t, await store.query<Record<string, unknown>>(MASTER_DEFS[t].collection, { where: [{ field: 'productId', op: '==', value: p.id }] }));
    }
  }
  for (const t of ['workers', 'vehicles', 'work-locations'] as const) {
    add(t, (await store.query<Record<string, unknown>>(MASTER_DEFS[t].collection)).filter((r) => String(r.data['code']).startsWith(prefix)));
  }
  const deactivated: Record<string, number> = {};
  for (const d of deact) deactivated[d.type] = (deactivated[d.type] ?? 0) + 1;

  // ---- 3. 利用者
  const users =
    opts.userPrefix.trim().length >= 3
      ? (await store.query<UserDoc>(C.users)).filter((u) => u.data.loginId.startsWith(opts.userPrefix.trim()) && u.data.status === 'ACTIVE' && !u.data.roles.includes('ADMIN'))
      : [];

  const result: PurgeResult = {
    applied: opts.apply,
    customers: customers.map((c) => String(c.data['code'])).sort(),
    reports: counts,
    deletedDocs: paths.length,
    storageKeys,
    deactivated,
    users: users.map((u) => u.data.loginId).sort(),
  };
  if (!opts.apply) return result;

  // ---- 実行: 削除（1回の transaction は 400 件まで）→ 無効化 → 利用停止 → 記録
  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    await store.runTransaction(async (tx) => {
      for (const p of chunk) tx.delete(p);
    });
  }
  const service = new MasterService(store, { billing: true });
  const ctx = { actorId: opts.actorId, correlationId: randomUUID(), now: opts.now };
  // 子（品番の下）から先に無効化する
  const order: MasterType[] = ['rates', 'transport-rules', 'fixed-charges', 'defects', 'work-types', 'contacts', 'products', 'customers', 'workers', 'vehicles', 'work-locations'];
  for (const type of order) {
    for (const d of deact.filter((x) => x.type === type)) {
      await service.deactivate(type, d.id, { expectedVersion: d.version, reason: opts.reason }, ctx, false);
    }
  }
  for (const u of users) {
    await store.runTransaction(async (tx) => {
      const cur = await tx.get<UserDoc>(`${C.users}/${u.id}`);
      if (cur === null || cur.status !== 'ACTIVE') return;
      tx.update(`${C.users}/${u.id}`, { status: 'INACTIVE', authChangedAt: opts.now, version: cur.version + 1, updatedAt: opts.now });
      appendAudit(tx, { actorId: opts.actorId, action: 'USER_DEACTIVATE', targetType: 'USER', targetId: u.id, beforeData: { status: 'ACTIVE' }, afterData: { status: 'INACTIVE' }, reason: opts.reason, correlationId: ctx.correlationId, occurredAt: opts.now }, opts.now);
    });
    invalidateUserGuard(u.id);
  }
  await store.runTransaction(async (tx) => {
    appendAudit(
      tx,
      {
        actorId: opts.actorId,
        action: 'TEST_DATA_PURGE',
        targetType: 'SYSTEM',
        targetId: ctx.correlationId,
        afterData: { prefix, customers: result.customers, reports: counts, deletedDocs: paths.length, storageObjects: storageKeys.length, deactivated, users: result.users },
        reason: opts.reason,
        correlationId: ctx.correlationId,
        occurredAt: opts.now,
      },
      opts.now,
    );
  });
  return result;
}
