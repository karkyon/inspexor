/**
 * 月次集計（提案書 P.6/P.10 / CHG-004 D4）: API-027 getMonthlySummary / API-028 exportMonthlySummary。
 *  - 対象: 暦月の確定済み報告の「現在の確定版」（current_revision_id）。修正中（新しい版が下書き）の報告は前の確定版で数える
 *  - 絞込: お客様・品番（運搬は明細に含む報告）・種別
 *  - 出力: 画面用 JSON、Excel（集計・日別・品番別・作業内容別・明細の5シート）、CSV（シート単位、UTF-8 BOM）
 *  運搬費は手入力分の合計のみ（按分・単価・請求額の計算はしない＝提案書の対象外）。
 *  CHG-006: 報告ヘッダの current（確定済みの現在版の要約）を業務日の範囲で読み、お客様・品番はアプリで絞り込む。
 */
import { C, REPORT_COLLECTION, type DeliveryCurrent, type DocStore, type ReportHeaderDoc, type WorkCurrent } from '@inspexor/docstore';
import { minutesToHours, monthRange, summarizeMonth, toCsv, type MonthlySummary, type SummaryRow } from '@inspexor/domain';
import { buildXlsx, type Cell, type Sheet } from './xlsx';

export interface MonthlyQuery {
  readonly month: string;
  readonly type: 'WORK' | 'DELIVERY' | null;
  readonly customerId: string | null;
  readonly productId: string | null;
}

export type ExportSheet = 'summary' | 'daily' | 'product' | 'worktype' | 'detail';
export const EXPORT_SHEETS: readonly ExportSheet[] = ['summary', 'daily', 'product', 'worktype', 'detail'];

interface Named {
  code: string;
  name: string;
}

export interface MonthlyView extends MonthlySummary {
  readonly filters: MonthlyQuery;
  readonly names: {
    readonly customers: Record<string, Named>;
    readonly products: Record<string, Named>;
    readonly workTypes: Record<string, { name: string }>;
  };
}

export class MonthlyService {
  constructor(private readonly store: DocStore) {}

  private async currents<T extends WorkCurrent | DeliveryCurrent>(collection: string, from: string, to: string): Promise<Array<{ id: string; h: ReportHeaderDoc; c: T }>> {
    const rows = await this.store.query<ReportHeaderDoc>(collection, {
      where: [
        { field: 'current.businessDate', op: '>=', value: from },
        { field: 'current.businessDate', op: '<=', value: to },
      ],
    });
    return rows.filter((r) => r.data.current !== null).map((r) => ({ id: r.id, h: r.data, c: r.data.current as T }));
  }

  async summary(q: MonthlyQuery): Promise<MonthlyView> {
    const { from, to } = monthRange(q.month);
    const rows: SummaryRow[] = [];
    if (q.type !== 'DELIVERY') {
      for (const { id, h, c } of await this.currents<WorkCurrent>(REPORT_COLLECTION.WORK, from, to)) {
        if (q.customerId !== null && c.customerId !== q.customerId) continue;
        if (q.productId !== null && c.productId !== q.productId) continue;
        rows.push({
          type: 'WORK', reportId: id, reportNo: h.reportNo, revisionNo: c.revisionNo, date: c.businessDate, customerId: c.customerId, productId: c.productId,
          workTypeId: c.workTypeId, quantity: c.quantity, defectQuantity: c.defectQuantity, actualMinutes: c.actualMinutes, personMinutes: c.personMinutes,
        });
      }
    }
    if (q.type !== 'WORK') {
      for (const { id, h, c } of await this.currents<DeliveryCurrent>(REPORT_COLLECTION.DELIVERY, from, to)) {
        if (q.customerId !== null && c.customerId !== q.customerId) continue;
        if (q.productId !== null && !c.items.some((i) => i.productId === q.productId)) continue;
        rows.push({
          type: 'DELIVERY', reportId: id, reportNo: h.reportNo, revisionNo: c.revisionNo, date: c.businessDate, customerId: c.customerId,
          items: c.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), tripCount: c.tripCount, deliveryFeeYen: h.deliveryFeeYen,
        });
      }
    }
    // 並びは PostgreSQL 版と同じく業務日→報告番号（summarizeMonth の明細順の入力を安定させる）
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.reportNo < b.reportNo ? -1 : a.reportNo > b.reportNo ? 1 : 0));
    const s = summarizeMonth(q.month, rows, q.productId);
    const customerIds = [...new Set(rows.map((x) => x.customerId))];
    const productIds = [...new Set(rows.flatMap((x) => (x.type === 'WORK' ? [x.productId] : x.items.map((i) => i.productId))))];
    const workTypeIds = [...new Set(rows.flatMap((x) => (x.type === 'WORK' ? [x.workTypeId] : [])))];
    const named = async (collection: string, ids: string[]): Promise<Record<string, Named>> => {
      if (ids.length === 0) return {};
      const docs = await this.store.getMany<{ code: string; name: string }>(ids.map((id) => `${collection}/${id}`));
      const out: Record<string, Named> = {};
      ids.forEach((id, i) => {
        const d = docs[i];
        if (d !== null && d !== undefined) out[id] = { code: d.code, name: d.name };
      });
      return out;
    };
    const products = await named(C.products, productIds);
    return {
      ...s,
      filters: q,
      byProduct: [...s.byProduct].sort((a, b) => (products[a.productId]?.code ?? '').localeCompare(products[b.productId]?.code ?? '')),
      names: {
        customers: await named(C.customers, customerIds),
        products,
        workTypes: Object.fromEntries(Object.entries(await named(C.workTypes, workTypeIds)).map(([k, v]) => [k, { name: v.name }])),
      },
    };
  }

  /** Excel（5シート）または CSV（1シート）。ファイル名は 月次集計_YYYY-MM[_シート].拡張子 */
  async export(q: MonthlyQuery, format: 'xlsx' | 'csv', sheet: ExportSheet): Promise<{ body: Uint8Array; contentType: string; fileName: string }> {
    const v = await this.summary(q);
    const sheets = buildSheets(v);
    if (format === 'xlsx') {
      return { body: buildXlsx(sheets), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: `月次集計_${q.month}.xlsx` };
    }
    const s = sheets[EXPORT_SHEETS.indexOf(sheet)] as Sheet;
    return { body: new TextEncoder().encode(toCsv(s.header, s.rows)), contentType: 'text/csv; charset=utf-8', fileName: `月次集計_${q.month}_${s.name}.csv` };
  }
}

const h = (m: number): number => Number(minutesToHours(m));

export function buildSheets(v: MonthlyView): Sheet[] {
  const p = (id: string) => v.names.products[id];
  const t = v.totals;
  const filterLabel = (id: string | null, map: Record<string, Named>) => (id === null ? 'すべて' : map[id] !== undefined ? `${map[id]?.code} ${map[id]?.name}` : id);
  const summary: Sheet = {
    name: '集計',
    header: ['項目', '値'],
    widths: [24, 28],
    rows: [
      ['対象年月', v.month],
      ['期間', `${v.from} 〜 ${v.to}`],
      ['お客様', filterLabel(v.filters.customerId, v.names.customers)],
      ['品番', filterLabel(v.filters.productId, v.names.products)],
      ['種別', v.filters.type === null ? 'すべて（作業・運搬）' : v.filters.type === 'WORK' ? '作業日報' : '運搬実績'],
      ['作業日報（件）', t.workCount],
      ['総作業個数（個）', t.workQuantity],
      ['総不良個数（個）', t.defectQuantity],
      ['実作業時間（時間）', h(t.actualMinutes)],
      ['総作業時間（人×時間）', h(t.personMinutes)],
      ['運搬実績（件）', t.deliveryCount],
      ['運搬数量（個）', t.deliveryQuantity],
      ['運搬回数（回）', t.tripCount],
      ['運搬費（入力分の合計・円）', t.deliveryFeeYen],
      ['運搬費 未入力（件）', t.deliveryFeeUnsetCount],
    ],
  };
  const daily: Sheet = {
    name: '日別',
    header: ['日付', '作業個数', '不良個数', '実作業時間(H)', '総作業時間(人H)', '運搬数量', '運搬回数', '運搬費(円)', '運搬費未入力(件)'],
    widths: [12, 10, 10, 13, 15, 10, 10, 12, 15],
    rows: v.daily.map((d) => [d.date, d.workQuantity, d.defectQuantity, h(d.actualMinutes), h(d.personMinutes), d.deliveryQuantity, d.tripCount, d.deliveryFeeYen, d.deliveryFeeUnsetCount]),
  };
  const product: Sheet = {
    name: '品番別',
    header: ['品番', '品名', '作業個数', '不良個数', '実作業時間(H)', '総作業時間(人H)', '運搬数量'],
    widths: [16, 28, 10, 10, 13, 15, 10],
    rows: v.byProduct.map((x) => [p(x.productId)?.code ?? '', p(x.productId)?.name ?? '', x.workQuantity, x.defectQuantity, h(x.actualMinutes), h(x.personMinutes), x.deliveryQuantity]),
  };
  const worktype: Sheet = {
    name: '作業内容別',
    header: ['品番', '品名', '作業内容', '件数', '作業個数', '不良個数', '実作業時間(H)', '総作業時間(人H)'],
    widths: [16, 28, 20, 8, 10, 10, 13, 15],
    rows: v.byWorkType.map((x) => [p(x.productId)?.code ?? '', p(x.productId)?.name ?? '', v.names.workTypes[x.workTypeId]?.name ?? '', x.workCount, x.workQuantity, x.defectQuantity, h(x.actualMinutes), h(x.personMinutes)]),
  };
  const detail: Sheet = {
    name: '明細',
    header: ['日付', '種別', '報告番号', '版', 'お客様', '品番', '作業内容', '数量', '不良数', '実作業時間(H)', '総作業時間(人H)', '運搬回数', '運搬費(円)'],
    widths: [12, 8, 18, 5, 22, 30, 16, 10, 8, 13, 15, 9, 11],
    rows: v.rows.map((r): Cell[] => {
      const c = v.names.customers[r.customerId];
      const customer = c === undefined ? '' : `${c.code} ${c.name}`;
      if (r.type === 'WORK') {
        return [r.date, '作業', r.reportNo, r.revisionNo, customer, p(r.productId)?.code ?? '', v.names.workTypes[r.workTypeId]?.name ?? '', r.quantity, r.defectQuantity, h(r.actualMinutes), h(r.personMinutes), null, null];
      }
      const items = r.items.filter((i) => v.filters.productId === null || i.productId === v.filters.productId);
      const codes = items.map((i) => p(i.productId)?.code ?? '').join(' / ');
      return [r.date, '運搬', r.reportNo, r.revisionNo, customer, codes, null, items.reduce((s, i) => s + i.quantity, 0), null, null, null, r.tripCount, r.deliveryFeeYen];
    }),
  };
  return [summary, daily, product, worktype, detail];
}
