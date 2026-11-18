/**
 * 在庫管理（API-047〜052、SK-2026-08-MINI-09）。画面・API から呼ぶ業務サービス。
 * 計算は packages/domain の inventory.ts、保存と排他は packages/docstore の inventory.ts に任せ、ここは
 * 入力の検査・品番の設定の参照・監査・在庫集計表の出力を行う。
 */
import {
  allocateFifo,
  balanceOf,
  replay,
  monthSheet,
  perHour,
  planDelivery,
  planOpening,
  planReplenish,
  planReversal,
  planStocktake,
  previewIssues,
  adjustIsLow,
  InventoryInputError,
  InventoryLotShortError,
  type CountBy,
  type InventoryIssue,
  type Movement,
  type PlannedMovement,
} from '@inspexor/domain';
import {
  appendAudit,
  C,
  InventoryRejectedError,
  hasOpening,
  readMovements,
  registerMovements,
  type DocStore,
  type MovementDoc,
  INVENTORY_COLLECTIONS,
} from '@inspexor/docstore';
import { buildXlsx, type Cell } from '../reports/xlsx';

export class InventoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: ReadonlyArray<{ path: string; code: string; message: string }>,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface InventoryContext {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly correlationId: string;
  readonly now: Date;
}

interface ProductDoc {
  readonly customerId: string;
  readonly code: string;
  readonly name: string;
  readonly active?: boolean;
  readonly inventoryManaged?: boolean;
  readonly unitsPerBox?: number | null;
  readonly adjustStockManaged?: boolean;
  readonly adjustLowThreshold?: number;
}

export interface ProductConfig {
  readonly productId: string;
  readonly code: string;
  readonly name: string;
  readonly customerId: string;
  readonly unitsPerBox: number | null;
  readonly adjustStockManaged: boolean;
  readonly adjustLowThreshold: number;
}

export interface IssueView {
  readonly kind: string;
  readonly businessDate: string;
  readonly lotKey: string | null;
  readonly quantity: number;
  readonly movementId: string;
}

export interface InventoryProductView extends ProductConfig {
  readonly deposit: number;
  readonly adjust: number;
  readonly lots: ReadonlyArray<{ lotKey: string; lotDate: string; lotLabel: string; quantity: number }>;
  readonly issues: readonly IssueView[];
  readonly adjustLow: boolean;
  readonly hasOpening: boolean;
  readonly openingDate: string | null;
  readonly asOf: string | null;
  readonly movementCount: number;
}

export interface MovementView {
  readonly id: string;
  readonly movementNo: string;
  readonly seq: number;
  readonly businessDate: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly type: string;
  readonly fromBucket: string;
  readonly toBucket: string;
  readonly lotKey: string | null;
  readonly lotLabel: string | null;
  readonly quantity: number;
  readonly sourceKind: string;
  readonly sourceReportId: string | null;
  readonly reason: string | null;
  readonly reversalOf: string | null;
  /** 取り消されている取引（取消しの対象になっている）か */
  readonly reversed: boolean;
  readonly meta: Record<string, unknown>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isBusinessDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export type RegisterAction = 'delivery' | 'replenish' | 'stocktake' | 'opening';
export const REGISTER_ACTIONS: readonly RegisterAction[] = ['delivery', 'replenish', 'stocktake', 'opening'];

export interface RegisterInput {
  readonly businessDate: string;
  readonly preview?: boolean | undefined;
  readonly acknowledgeAdjustShort?: boolean | undefined;
  readonly reason?: string | undefined;
  // delivery
  readonly quantity?: number | undefined;
  // replenish（検品ロットと箱数）
  readonly lotKey?: string | undefined;
  readonly boxes?: number | undefined;
  // stocktake
  readonly countedDeposit?: number | undefined;
  readonly countedAdjust?: number | undefined;
  // opening
  readonly adjust?: number | undefined;
  readonly lots?: ReadonlyArray<{ lotDate: string; lotLabel?: string | undefined; quantity: number }> | undefined;
}

const toIssueView = (i: InventoryIssue): IssueView => ({ kind: i.kind, businessDate: i.businessDate, lotKey: i.lotKey ?? null, quantity: i.quantity, movementId: i.movementId });

const viewOfMovement = (m: Movement & { movementNo: string }, d: MovementDoc, reversed: Set<string>): MovementView => ({
  id: m.id,
  movementNo: m.movementNo,
  seq: m.seq,
  businessDate: m.businessDate,
  occurredAt: d.occurredAt.toISOString(),
  actorId: d.actorId,
  type: m.type,
  fromBucket: m.fromBucket,
  toBucket: m.toBucket,
  lotKey: m.lotKey ?? null,
  lotLabel: m.lotLabel ?? null,
  quantity: m.quantity,
  sourceKind: d.sourceKind,
  sourceReportId: d.sourceReportId ?? null,
  reason: m.reason ?? null,
  reversalOf: m.reversalOf ?? null,
  reversed: reversed.has(m.id),
  meta: m.meta as Record<string, unknown>,
});

export class InventoryService {
  constructor(private readonly store: DocStore) {}

  /** 在庫を管理する品番の設定（品番マスタ）。無ければ 404 */
  async config(productId: string): Promise<ProductConfig> {
    const p = await this.store.get<ProductDoc>(`${C.products}/${productId}`);
    if (p === null || p.inventoryManaged !== true) throw new InventoryError(404, 'VALIDATION_ERROR', '在庫を管理する品番が見つかりません。', [{ path: '/productId', code: 'not_found', message: '在庫を管理する品番ではありません。' }]);
    return configOf(productId, p);
  }

  async configs(): Promise<ProductConfig[]> {
    const rows = await this.store.query<ProductDoc>(C.products, { where: [{ field: 'inventoryManaged', op: '==', value: true }] });
    return rows
      .filter((r) => r.data.active !== false)
      .map((r) => configOf(r.id, r.data))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

  /** API-047 品番ごとの残高。asOf を渡すとその日の終わりの値 */
  async list(asOf: string | null): Promise<InventoryProductView[]> {
    const out: InventoryProductView[] = [];
    for (const cfg of await this.configs()) {
      const movements = await readMovements(this.store, cfg.productId);
      out.push(viewOf(cfg, movements, asOf));
    }
    return out;
  }

  async one(productId: string, asOf: string | null): Promise<InventoryProductView> {
    const cfg = await this.config(productId);
    return viewOf(cfg, await readMovements(this.store, productId), asOf);
  }

  /** API-048 取引の一覧（新しい順） */
  async movements(productId: string, filter: { from: string | null; to: string | null; type: string | null; includeReversed: boolean }): Promise<MovementView[]> {
    await this.config(productId);
    const rows = await this.store.query<MovementDoc>(INVENTORY_COLLECTIONS.movements, { where: [{ field: 'productId', op: '==', value: productId }], orderBy: [{ field: 'seq', dir: 'asc' }] });
    const reversed = new Set(rows.map((r) => r.data.reversalOf).filter((x): x is string => !!x));
    return rows
      .map((r) => ({ r, m: { id: r.id, movementNo: r.data.movementNo } }))
      .filter(({ r }) => (filter.from === null || r.data.businessDate >= filter.from) && (filter.to === null || r.data.businessDate <= filter.to) && (filter.type === null || r.data.type === filter.type))
      .filter(({ r }) => filter.includeReversed || (!reversed.has(r.id) && r.data.type !== 'REVERSAL'))
      .map(({ r }) => viewOfMovement({ id: r.id, movementNo: r.data.movementNo, seq: r.data.seq, productId, businessDate: r.data.businessDate, type: r.data.type, fromBucket: r.data.fromBucket, toBucket: r.data.toBucket, quantity: r.data.quantity, ...(r.data.lotKey ? { lotKey: r.data.lotKey } : {}), ...(r.data.lotLabel ? { lotLabel: r.data.lotLabel } : {}), ...(r.data.reason ? { reason: r.data.reason } : {}), ...(r.data.reversalOf ? { reversalOf: r.data.reversalOf } : {}), meta: r.data.meta ?? {} }, r.data, reversed))
      .sort((a, b) => (a.businessDate === b.businessDate ? b.seq - a.seq : a.businessDate < b.businessDate ? 1 : -1));
  }

  /** API-049 納入・振替・棚卸・開始残高。preview=true なら保存せず、増減・引当・問題点を返す */
  async register(productId: string, action: RegisterAction, input: RegisterInput, ctx: InventoryContext): Promise<Record<string, unknown>> {
    const cfg = await this.config(productId);
    if (!isBusinessDate(input.businessDate)) throw new InventoryError(422, 'VALIDATION_ERROR', '取引日を入力してください。', [{ path: '/businessDate', code: 'required', message: '取引日（業務日）を YYYY-MM-DD で入力してください。' }]);
    const build = (existing: readonly Movement[]): PlannedMovement[] => this.plan(cfg, action, input, existing);
    if (input.preview === true) {
      const existing = await readMovements(this.store, productId);
      let planned: PlannedMovement[];
      try {
        planned = build(existing);
      } catch (e) {
        throw mapDomainError(e);
      }
      const pv = previewIssues(existing, planned);
      return {
        preview: true,
        businessDate: input.businessDate,
        movements: planned.map(previewRow),
        afterDeposit: pv.after?.deposit ?? null,
        afterAdjust: pv.after?.adjust ?? null,
        issues: pv.issues.map(toIssueView),
        blocked: pv.issues.some((i) => i.kind === 'LOT_NEGATIVE') ? 'INVENTORY_LOT_SHORT' : pv.issues.length > 0 && input.acknowledgeAdjustShort !== true ? 'INVENTORY_ADJUST_SHORT' : null,
      };
    }
    try {
      const result = await this.store.runTransaction(async (tx) => {
        const r = await registerMovements(tx, productId, build, { actorId: ctx.actorId, now: ctx.now, correlationId: ctx.correlationId, sourceKind: 'SCREEN', acknowledgeAdjustShort: input.acknowledgeAdjustShort === true });
        appendAudit(
          tx,
          { actorId: ctx.actorId, action: AUDIT_ACTION[action], targetType: 'inventory', targetId: productId, afterData: { movementNos: r.movements.map((m) => m.movementNo), businessDate: input.businessDate }, ...(input.reason ? { reason: input.reason } : {}), correlationId: ctx.correlationId },
          ctx.now,
        );
        return r;
      });
      return {
        preview: false,
        movements: result.movements.map((m) => ({ id: m.id, movementNo: m.movementNo, type: m.type, businessDate: m.businessDate, quantity: m.quantity, lotKey: m.lotKey ?? null })),
        balance: { deposit: result.balance.deposit, adjust: result.balance.adjust },
        issues: result.issues.map(toIssueView),
      };
    } catch (e) {
      throw mapDomainError(e);
    }
  }

  private plan(cfg: ProductConfig, action: RegisterAction, input: RegisterInput, existing: readonly Movement[]): PlannedMovement[] {
    const pid = cfg.productId;
    const date = input.businessDate;
    const need = (cond: boolean, path: string, message: string): void => {
      if (!cond) throw new InventoryError(422, 'VALIDATION_ERROR', message, [{ path, code: 'invalid', message }]);
    };
    if (action !== 'opening' && !hasOpening(existing)) throw new InventoryError(409, 'STATE_CONFLICT', '開始残高を登録してから操作してください。', [{ path: '/action', code: 'state', message: '開始残高が未登録です。' }]);
    switch (action) {
      case 'delivery': {
        need(Number.isInteger(input.quantity) && (input.quantity as number) > 0, '/quantity', '納入数は 1 以上の整数で入力してください。');
        const alloc = allocateFifo(existing, pid, date, input.quantity as number);
        return planDelivery({ productId: pid, businessDate: date, allocations: alloc, ...(input.reason ? { reason: input.reason } : {}) });
      }
      case 'replenish': {
        need(!!input.lotKey, '/lotKey', '検品ロットを選んでください。');
        need(cfg.adjustStockManaged, '/productId', 'この品番は調整用在庫を管理していません。');
        need(cfg.unitsPerBox !== null, '/productId', 'この品番の1箱の入数が未登録です。品番マスタで登録してください。');
        need(Number.isInteger(input.boxes) && (input.boxes as number) > 0, '/boxes', '箱数は 1 以上の整数で入力してください。');
        const lot = replayLot(existing, pid, date, input.lotKey as string);
        need(lot !== null, '/lotKey', '選んだ検品ロットはこの日に預かり在庫がありません。');
        const l = lot as { lotKey: string; lotDate: string; lotLabel: string };
        return planReplenish({ productId: pid, businessDate: date, lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: (input.boxes as number) * (cfg.unitsPerBox as number), ...(input.reason ? { reason: input.reason } : {}) });
      }
      case 'stocktake': {
        need(!!input.reason?.trim(), '/reason', '棚卸の理由を入力してください。');
        need(Number.isInteger(input.countedDeposit) && (input.countedDeposit as number) >= 0, '/countedDeposit', '数えた預かり在庫を 0 以上の整数で入力してください。');
        if (cfg.adjustStockManaged) need(Number.isInteger(input.countedAdjust) && (input.countedAdjust as number) >= 0, '/countedAdjust', '数えた調整用在庫を 0 以上の整数で入力してください。');
        return planStocktake(existing, { productId: pid, businessDate: date, countDeposit: input.countedDeposit as number, countAdjust: input.countedAdjust ?? 0, adjustManaged: cfg.adjustStockManaged, reason: input.reason as string });
      }
      case 'opening': {
        need(!hasOpening(existing), '/action', '開始残高は登録済みです。');
        need(Number.isInteger(input.adjust ?? 0) && (input.adjust ?? 0) >= 0, '/adjust', '調整用在庫は 0 以上の整数で入力してください。');
        const lots = (input.lots ?? []).map((l, i) => {
          need(isBusinessDate(l.lotDate), `/lots/${i}/lotDate`, '検品日を入力してください。');
          return { lotKey: `${l.lotDate}|開始${i + 1}`, lotDate: l.lotDate, lotLabel: l.lotLabel?.trim() || `${l.lotDate} 検品分（開始残高）`, quantity: l.quantity };
        });
        return planOpening({ productId: pid, businessDate: date, adjust: cfg.adjustStockManaged ? (input.adjust ?? 0) : 0, lots });
      }
    }
  }

  /** API-052 取消し（理由必須）。在庫の画面で登録した取引だけ */
  async reverse(productId: string, movementId: string, reason: string, ctx: InventoryContext): Promise<Record<string, unknown>> {
    await this.config(productId);
    if (!reason.trim()) throw new InventoryError(422, 'VALIDATION_ERROR', '取消しの理由を入力してください。', [{ path: '/reason', code: 'required', message: '取消しの理由は必須です。' }]);
    try {
      const result = await this.store.runTransaction(async (tx) => {
        const doc = await tx.get<MovementDoc>(`${INVENTORY_COLLECTIONS.movements}/${movementId}`);
        if (doc === null || doc.productId !== productId) throw new InventoryError(404, 'VALIDATION_ERROR', '取引が見つかりません。', [{ path: '/movementId', code: 'not_found', message: '取引が見つかりません。' }]);
        if (doc.type === 'REVERSAL') throw new InventoryError(409, 'STATE_CONFLICT', '取消しの取引は取り消せません。', [{ path: '/movementId', code: 'state', message: '取消しの取引です。' }]);
        if (doc.sourceKind !== 'SCREEN') throw new InventoryError(409, 'STATE_CONFLICT', '日報から作られた取引は、日報の修正で直します。', [{ path: '/movementId', code: 'state', message: '日報の取引です。' }]);
        const r = await registerMovements(
          tx,
          productId,
          (existing) => {
            const target = existing.find((m) => m.id === movementId);
            if (!target) throw new InventoryError(404, 'VALIDATION_ERROR', '取引が見つかりません。');
            if (existing.some((m) => m.reversalOf === movementId)) throw new InventoryError(409, 'STATE_CONFLICT', 'この取引は取消し済みです。', [{ path: '/movementId', code: 'state', message: '取消し済みです。' }]);
            return [planReversal(target, reason.trim())];
          },
          { actorId: ctx.actorId, now: ctx.now, correlationId: ctx.correlationId, sourceKind: 'SCREEN', acknowledgeAdjustShort: true },
        );
        appendAudit(tx, { actorId: ctx.actorId, action: 'INVENTORY_REVERSAL', targetType: 'inventory', targetId: productId, afterData: { reversedMovementId: movementId, movementNos: r.movements.map((m) => m.movementNo) }, reason: reason.trim(), correlationId: ctx.correlationId }, ctx.now);
        return r;
      });
      return { movements: result.movements.map((m) => ({ id: m.id, movementNo: m.movementNo, type: m.type, businessDate: m.businessDate, quantity: m.quantity })), balance: { deposit: result.balance.deposit, adjust: result.balance.adjust }, issues: result.issues.map(toIssueView) };
    } catch (e) {
      throw mapDomainError(e);
    }
  }

  /** API-051 在庫集計表（画面表示用の値） */
  async monthly(productId: string, month: string, countBy: CountBy): Promise<Record<string, unknown>> {
    const cfg = await this.config(productId);
    const movements = await readMovements(this.store, productId);
    const sheet = monthSheet(movements, productId, month, countBy);
    return {
      productId,
      code: cfg.code,
      name: cfg.name,
      month,
      countBy,
      rows: sheet.rows.map((r) => ({ ...r, perHour: perHour(r.selected, r.hours) })),
      totals: sheet.totals,
    };
  }

  /** API-050 在庫集計表（Excel）。productId を省くと在庫を管理する品番ごとのシート */
  async export(month: string, countBy: CountBy, productId: string | null): Promise<{ fileName: string; contentType: string; body: Uint8Array }> {
    const cfgs = productId === null ? await this.configs() : [await this.config(productId)];
    const sheets = [];
    for (const cfg of cfgs) {
      const movements = await readMovements(this.store, cfg.productId);
      const s = monthSheet(movements, cfg.productId, month, countBy);
      const ngKeys = [...new Set(s.rows.flatMap((r) => Object.keys(r.ngBy)))].sort();
      const header = ['日付', '曜日', 'ロットNo', '前回残', '持帰り数量', '選別数量', ...ngKeys.map((k) => `NG ${k}`), 'NG 合計', '丸五納入数量', '当日残', '運搬費', '備考', '記入者', '確認者', '作業時間', '1時間あたり個数'];
      const rows: Cell[][] = s.rows.map((r) => {
        const d = new Date(`${r.date}T00:00:00Z`);
        const wd = '日月火水木金土'[d.getUTCDay()] ?? '';
        const notes = [r.replenish ? `補充${r.replenish}` : '', r.boxDifference ? `箱誤差${r.boxDifference > 0 ? '+' : ''}${r.boxDifference}` : '', r.stocktake ? '棚卸' : '', !r.inMonth ? '翌月の納入' : ''].filter(Boolean).join(' ');
        return [
          r.date,
          wd,
          r.lotNo || null,
          r.prevAdjust,
          r.takeBack,
          r.selected,
          ...ngKeys.map((k) => r.ngBy[k] ?? null),
          r.ngTotal || null,
          r.delivered,
          r.endAdjust,
          null,
          notes || null,
          r.writer || null,
          null,
          r.hours,
          perHour(r.selected, r.hours),
        ];
      });
      rows.push(['合計', null, null, `期首 ${s.totals.openAdjust}`, s.totals.takeBack, s.totals.selected, ...ngKeys.map((k) => s.totals.ngBy[k] ?? 0), s.totals.ngTotal, s.totals.delivered, `期末 ${s.totals.closeAdjust}`, null, `月末の預かり在庫 ${s.totals.closeDeposit}`, null, null, null, null]);
      sheets.push({ name: `${cfg.code} ${month}`, header, rows, widths: [12, 5, 14, 9, 11, 11, ...ngKeys.map(() => 9), 9, 12, 9, 9, 24, 9, 9, 9, 12] });
    }
    if (sheets.length === 0) throw new InventoryError(404, 'VALIDATION_ERROR', '在庫を管理する品番がありません。');
    return { fileName: `在庫集計表_${month}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: buildXlsx(sheets) };
  }
}

const AUDIT_ACTION: Record<RegisterAction, string> = { delivery: 'INVENTORY_DELIVERY', replenish: 'INVENTORY_REPLENISH', stocktake: 'INVENTORY_STOCKTAKE', opening: 'INVENTORY_OPENING' };

function configOf(productId: string, p: ProductDoc): ProductConfig {
  return { productId, code: p.code, name: p.name, customerId: p.customerId, unitsPerBox: p.unitsPerBox ?? null, adjustStockManaged: p.adjustStockManaged === true, adjustLowThreshold: p.adjustLowThreshold ?? 20 };
}

function viewOf(cfg: ProductConfig, movements: ReadonlyArray<Movement & { movementNo: string }>, asOf: string | null): InventoryProductView {
  const r = replayAsOf(movements, cfg.productId, asOf);
  const open = hasOpening(movements);
  const first = movements.filter((m) => m.type === 'OPENING').map((m) => m.businessDate).sort()[0] ?? null;
  return {
    ...cfg,
    deposit: r.deposit,
    adjust: r.adjust,
    lots: r.lots.map((l) => ({ lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel, quantity: l.quantity })),
    issues: r.issues.map(toIssueView),
    adjustLow: adjustIsLow({ deposit: r.deposit, adjust: r.adjust, lots: r.lots }, { inventoryManaged: true, unitsPerBox: cfg.unitsPerBox, adjustStockManaged: cfg.adjustStockManaged, adjustLowThreshold: cfg.adjustLowThreshold }),
    hasOpening: open,
    openingDate: first,
    asOf,
    movementCount: movements.length,
  };
}

function replayAsOf(movements: readonly Movement[], productId: string, asOf: string | null) {
  const b = balanceOf(movements, productId, asOf ?? undefined);
  const issues = replay(movements, asOf ?? undefined).issues;
  return { ...b, issues };
}

/** その日の時点で預かり在庫が残っている検品ロット */
function replayLot(existing: readonly Movement[], pid: string, date: string, lotKey: string): { lotKey: string; lotDate: string; lotLabel: string } | null {
  const b = balanceOf(existing, pid, date);
  const l = b.lots.find((x) => x.lotKey === lotKey && x.quantity > 0);
  return l ? { lotKey: l.lotKey, lotDate: l.lotDate, lotLabel: l.lotLabel } : null;
}

function previewRow(p: PlannedMovement): Record<string, unknown> {
  return { type: p.type, fromBucket: p.fromBucket, toBucket: p.toBucket, quantity: p.quantity, lotKey: p.lotKey ?? null, lotLabel: p.lotLabel ?? null, lotDate: p.lotDate ?? null };
}

/** domain・docstore の例外を API の例外に写す */
export function mapDomainError(e: unknown): unknown {
  if (e instanceof InventoryError) return e;
  if (e instanceof InventoryRejectedError) {
    return new InventoryError(422, e.code, e.message, undefined, { issues: e.issues.map(toIssueView) });
  }
  if (e instanceof InventoryLotShortError) {
    return new InventoryError(422, 'INVENTORY_LOT_SHORT', e.message, undefined, { available: e.available, requested: e.requested });
  }
  if (e instanceof InventoryInputError) return new InventoryError(422, 'VALIDATION_ERROR', e.message);
  return e;
}
