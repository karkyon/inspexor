/**
 * 在庫管理の文書形と登録（SK-2026-08-MINI-09 13章、CHG-015 第3版・CHG-018）。
 *
 *  inventoryMovements/{uuid}   取引の記録（追加のみ。変更・削除の手段を持たない）
 *  inventoryBalances/{productId}  積み上げ結果の写し（登録と同じ transaction で更新。食い違ったら取引の記録が正）
 *
 * 登録の手順（1品番ごと）: ①transaction の中で残高の写しと取引の全件を読む → ②domain の積み上げで問題点を判定
 * → ③取引を seq 順に追記し、残高の写しを書き換える。同時の登録は transaction の競合で再試行される。
 */
import { randomUUID } from 'node:crypto';
import {
  audit,
  balanceOf,
  replay,
  type Bucket,
  type InventoryIssue,
  type Movement,
  type MovementMeta,
  type MovementType,
  type PlannedMovement,
  type ProductBalance,
} from '@inspexor/domain';
import type { DocReader, DocTransaction } from './types';

export type MovementSource = 'REPORT' | 'SCREEN';

export interface MovementDoc {
  readonly productId: string;
  readonly seq: number;
  readonly movementNo: string;
  readonly businessDate: string;
  readonly occurredAt: Date;
  readonly actorId: string;
  readonly type: MovementType;
  readonly fromBucket: Bucket;
  readonly toBucket: Bucket;
  readonly lotKey?: string | null;
  readonly lotDate?: string | null;
  readonly lotLabel?: string | null;
  readonly quantity: number;
  readonly sourceKind: MovementSource;
  readonly sourceReportId?: string | null;
  readonly sourceRevisionId?: string | null;
  readonly sourceRevisionNo?: number | null;
  readonly reason?: string | null;
  readonly reversalOf?: string | null;
  readonly meta: MovementMeta;
  readonly correlationId: string;
}

export interface BalanceDoc {
  readonly deposit: number;
  readonly adjust: number;
  readonly lots: ReadonlyArray<{ readonly lotKey: string; readonly lotDate: string; readonly lotLabel: string; readonly quantity: number }>;
  readonly issues: ReadonlyArray<{ readonly kind: string; readonly businessDate: string; readonly lotKey: string | null; readonly quantity: number; readonly movementId: string }>;
  readonly openingDate: string | null;
  readonly lastSeq: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export const INVENTORY_COLLECTIONS = { movements: 'inventoryMovements', balances: 'inventoryBalances' } as const;

export function movementNoOf(seq: number): string {
  return `M${String(seq).padStart(6, '0')}`;
}

/** 文書 → ドメインの取引（id は文書 ID） */
export function toMovement(id: string, d: MovementDoc): Movement & { readonly movementNo: string } {
  return {
    id,
    seq: d.seq,
    movementNo: d.movementNo,
    productId: d.productId,
    businessDate: d.businessDate,
    type: d.type,
    fromBucket: d.fromBucket,
    toBucket: d.toBucket,
    ...(d.lotKey ? { lotKey: d.lotKey } : {}),
    ...(d.lotDate ? { lotDate: d.lotDate } : {}),
    ...(d.lotLabel ? { lotLabel: d.lotLabel } : {}),
    quantity: d.quantity,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.reversalOf ? { reversalOf: d.reversalOf } : {}),
    meta: d.meta ?? {},
  };
}

/** 品番の取引を全件（業務日 → 登録順）読む */
export async function readMovements(db: DocReader, productId: string): Promise<Array<Movement & { readonly movementNo: string }>> {
  const rows = await db.query<MovementDoc>(INVENTORY_COLLECTIONS.movements, { where: [{ field: 'productId', op: '==', value: productId }], orderBy: [{ field: 'seq', dir: 'asc' }] });
  return rows.map((r) => toMovement(r.id, r.data));
}

export async function readBalance(db: DocReader, productId: string): Promise<BalanceDoc | null> {
  return db.get<BalanceDoc>(`${INVENTORY_COLLECTIONS.balances}/${productId}`);
}

/** 在庫を持つ品番の残高の写し（品番 ID → 写し） */
export async function readAllBalances(db: DocReader): Promise<Map<string, BalanceDoc>> {
  const rows = await db.query<BalanceDoc>(INVENTORY_COLLECTIONS.balances);
  return new Map(rows.map((r) => [r.id, r.data]));
}

/** 開始残高が登録済みか（登録するまで日報に在庫の欄を出さない） */
export function hasOpening(movements: readonly Movement[]): boolean {
  return movements.some((m) => m.type === 'OPENING' && !movements.some((x) => x.reversalOf === m.id));
}

export type InventoryRejectCode = 'INVENTORY_LOT_SHORT' | 'INVENTORY_ADJUST_SHORT';

export class InventoryRejectedError extends Error {
  constructor(
    readonly code: InventoryRejectCode,
    message: string,
    readonly issues: readonly InventoryIssue[],
    readonly productId: string,
  ) {
    super(message);
  }
}

export interface RegisterContext {
  readonly actorId: string;
  readonly now: Date;
  readonly correlationId: string;
  readonly sourceKind: MovementSource;
  readonly sourceReportId?: string;
  readonly sourceRevisionId?: string;
  readonly sourceRevisionNo?: number;
  /** 調整用在庫が足りなくなっても記録する（確認のチェック） */
  readonly acknowledgeAdjustShort?: boolean;
}

export interface RegisterResult {
  readonly movements: ReadonlyArray<Movement & { readonly movementNo: string }>;
  readonly balance: ProductBalance;
  readonly issues: readonly InventoryIssue[];
  readonly newIssues: readonly InventoryIssue[];
}

/** 取引の追加で新しく出る問題点を判定し、LOT_NEGATIVE は常に、ADJ_NEGATIVE は確認なしなら拒否する */
export function judgeIssues(productId: string, newIssues: readonly InventoryIssue[], acknowledgeAdjustShort: boolean): void {
  const lot = newIssues.find((i) => i.kind === 'LOT_NEGATIVE');
  if (lot) throw new InventoryRejectedError('INVENTORY_LOT_SHORT', `預かり在庫が足りません（${lot.businessDate} 時点で ${Math.abs(lot.quantity)} 個不足）。`, newIssues, productId);
  const adj = newIssues.find((i) => i.kind === 'ADJ_NEGATIVE');
  if (adj && !acknowledgeAdjustShort) throw new InventoryRejectedError('INVENTORY_ADJUST_SHORT', `調整用在庫が ${adj.quantity} 個になります。確認のうえ、確認欄にチェックを入れてください。`, newIssues, productId);
}

/**
 * 1品番の取引を transaction の中で追記する。
 * build は「いま記録されている取引」から追加する取引を作る（納入の引当・棚卸の差のため）。
 * すべての読込は書込より前に行う。
 */
export async function registerMovements(tx: DocTransaction, productId: string, build: (existing: readonly Movement[]) => readonly PlannedMovement[], ctx: RegisterContext): Promise<RegisterResult> {
  const prevBalance = await readBalance(tx, productId);
  const existing = await readMovements(tx, productId);
  const planned = build(existing);
  if (planned.length === 0) {
    const cur = balanceOf(existing, productId);
    return { movements: [], balance: cur, issues: replay(existing).issues, newIssues: [] };
  }
  let seq = existing.reduce((a, m) => Math.max(a, m.seq), 0);
  const created = planned.map((p) => {
    seq += 1;
    const id = randomUUID();
    return { ...p, id, seq, movementNo: movementNoOf(seq) };
  });
  const before = new Set(replay(existing).issues.map((i) => `${i.kind}|${i.movementId}`));
  const after = replay([...existing, ...created]);
  const newIssues = after.issues.filter((i) => !before.has(`${i.kind}|${i.movementId}`));
  judgeIssues(productId, newIssues, ctx.acknowledgeAdjustShort === true);
  // 保存則の検査（登録のたびに実行）。形の崩れは内部の誤りとして止める
  const a = audit([...existing, ...created]);
  if (!a.ok) throw new Error(`在庫の保存則に反する取引です: ${a.errors.join(' / ')}`);

  for (const m of created) {
    const doc: MovementDoc = {
      productId,
      seq: m.seq,
      movementNo: m.movementNo,
      businessDate: m.businessDate,
      occurredAt: ctx.now,
      actorId: ctx.actorId,
      type: m.type,
      fromBucket: m.fromBucket,
      toBucket: m.toBucket,
      lotKey: m.lotKey ?? null,
      lotDate: m.lotDate ?? null,
      lotLabel: m.lotLabel ?? null,
      quantity: m.quantity,
      sourceKind: ctx.sourceKind,
      sourceReportId: ctx.sourceReportId ?? null,
      sourceRevisionId: ctx.sourceRevisionId ?? null,
      sourceRevisionNo: ctx.sourceRevisionNo ?? null,
      reason: m.reason ?? null,
      reversalOf: m.reversalOf ?? null,
      meta: m.meta,
      correlationId: ctx.correlationId,
    };
    tx.create(`${INVENTORY_COLLECTIONS.movements}/${m.id}`, doc);
  }
  const bal = after.balances[productId] ?? { adjust: 0, deposit: 0, lots: [] };
  const opening = [...existing, ...created].filter((m) => m.type === 'OPENING').map((m) => m.businessDate).sort()[0] ?? null;
  const balanceDoc: BalanceDoc = {
    deposit: bal.deposit,
    adjust: bal.adjust,
    lots: bal.lots.map((l) => ({ lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: l.quantity })),
    issues: after.issues.map((i) => ({ kind: i.kind, businessDate: i.businessDate, lotKey: i.lotKey ?? null, quantity: i.quantity, movementId: i.movementId })),
    openingDate: opening,
    lastSeq: seq,
    version: (prevBalance?.version ?? 0) + 1,
    updatedAt: ctx.now,
  };
  tx.set(`${INVENTORY_COLLECTIONS.balances}/${productId}`, balanceDoc);
  return { movements: created, balance: bal, issues: after.issues, newIssues };
}

/** 参照: 品番の残高（取引から積み上げた値）。asOf を渡すとその日の終わり */
export async function inventoryBalanceAsOf(db: DocReader, productId: string, asOf?: string): Promise<{ balance: ProductBalance; issues: readonly InventoryIssue[]; movements: Array<Movement & { readonly movementNo: string }> }> {
  const movements = await readMovements(db, productId);
  const r = replay(movements, asOf);
  return { balance: r.balances[productId] ?? { adjust: 0, deposit: 0, lots: [] }, issues: r.issues, movements };
}
