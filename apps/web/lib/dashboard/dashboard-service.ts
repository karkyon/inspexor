/**
 * CHG-007 API-029 GET /dashboard（SCR-10 管理ダッシュボード、FR-017）。APPROVAL_ENABLED のときだけ提供する。
 *   KPI: 承認待ち（うち24時間超過）・本日の作業日報（確定済み/下書き）・本日の運搬（件数/品番数）・帳票の処理失敗
 *   直近7日: 業務日ごとの確定済み報告の件数（作業/運搬）
 *   要対応: 帳票の処理失敗・24時間を超えた承認待ち・差戻し中（新しい順に最大20件）
 * Firestore の検索はすべて単一項目の条件（複合索引不要）で、件数はアプリで数える（小規模: 7日で数百件程度）。
 */
import { toJstParts } from '@inspexor/domain';
import { C, REPORT_COLLECTION, reportPath, type DocReader, type DocumentJobDoc, type ReportHeaderDoc } from '@inspexor/docstore';

type ReportType = 'WORK' | 'DELIVERY';

export interface DashboardData {
  readonly asOf: string;
  readonly today: string;
  readonly kpis: {
    readonly pendingApproval: number;
    readonly pendingOver24h: number;
    readonly todayWorkConfirmed: number;
    readonly todayWorkDraft: number;
    readonly todayDeliveryCount: number;
    readonly todayDeliveryProducts: number;
    readonly failedDocuments: number;
  };
  readonly daily: ReadonlyArray<{ readonly date: string; readonly work: number; readonly delivery: number }>;
  readonly attention: ReadonlyArray<{
    readonly kind: 'DOCUMENT_FAILED' | 'APPROVAL_OVERDUE' | 'REJECTED';
    readonly type: ReportType;
    readonly reportId: string;
    readonly reportNo: string;
    readonly at: string;
  }>;
}

const DAY_MS = 86_400_000;
const OVERDUE_MS = DAY_MS;
const ATTENTION_MAX = 20;

/** 'YYYY-MM-DD' に日数を足す（暦日。時差の影響を受けないよう UTC で計算） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

export class DashboardService {
  constructor(private readonly db: DocReader) {}

  async get(now: Date): Promise<DashboardData> {
    const today = toJstParts(now).date;
    const from = addDays(today, -6);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const types: ReportType[] = ['WORK', 'DELIVERY'];

    const [recent, submitted, rejected, failed] = await Promise.all([
      Promise.all(types.map((t) => this.db.query<ReportHeaderDoc>(REPORT_COLLECTION[t], { where: [{ field: 'businessDate', op: '>=', value: from }] }))),
      Promise.all(types.map((t) => this.db.query<ReportHeaderDoc>(REPORT_COLLECTION[t], { where: [{ field: 'status', op: '==', value: 'SUBMITTED' }] }))),
      Promise.all(types.map((t) => this.db.query<ReportHeaderDoc>(REPORT_COLLECTION[t], { where: [{ field: 'status', op: '==', value: 'REJECTED' }] }))),
      this.db.query<DocumentJobDoc>(C.documents, { where: [{ field: 'status', op: '==', value: 'FAILED_FINAL' }] }),
    ]);

    const work = recent[0] ?? [];
    const delivery = recent[1] ?? [];
    const confirmed = (h: ReportHeaderDoc): boolean => h.status !== 'DRAFT';
    const daily = days.map((date) => ({
      date,
      work: work.filter((r) => r.data.businessDate === date && confirmed(r.data)).length,
      delivery: delivery.filter((r) => r.data.businessDate === date && confirmed(r.data)).length,
    }));
    const todayWork = work.filter((r) => r.data.businessDate === today);
    const todayDelivery = delivery.filter((r) => r.data.businessDate === today && confirmed(r.data));

    const attention: Array<DashboardData['attention'][number]> = [];
    let pendingOver24h = 0;
    submitted.forEach((rows, i) => {
      for (const r of rows) {
        const at = r.data.submittedAt ?? r.data.updatedAt;
        if (now.getTime() - at.getTime() > OVERDUE_MS) {
          pendingOver24h += 1;
          attention.push({ kind: 'APPROVAL_OVERDUE', type: types[i] as ReportType, reportId: r.id, reportNo: r.data.reportNo, at: at.toISOString() });
        }
      }
    });
    rejected.forEach((rows, i) => {
      for (const r of rows) {
        const at = r.data.decision?.at ?? r.data.updatedAt;
        attention.push({ kind: 'REJECTED', type: types[i] as ReportType, reportId: r.id, reportNo: r.data.reportNo, at: at.toISOString() });
      }
    });
    // 帳票の失敗は、その報告の最新の帳票のときだけ（再出力で成功していれば対象外）
    const failedHeaders = await this.db.getMany<ReportHeaderDoc>(failed.map((f) => reportPath(f.data.reportType, f.data.reportId)));
    let failedDocuments = 0;
    failed.forEach((f, i) => {
      const h = failedHeaders[i];
      if (h === null || h === undefined || h.documentId !== f.id) return;
      failedDocuments += 1;
      attention.push({ kind: 'DOCUMENT_FAILED', type: f.data.reportType, reportId: f.data.reportId, reportNo: h.reportNo, at: f.data.updatedAt.toISOString() });
    });
    attention.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.reportNo < b.reportNo ? -1 : 1));

    return {
      asOf: now.toISOString(),
      today,
      kpis: {
        pendingApproval: submitted.reduce((n, rows) => n + rows.length, 0),
        pendingOver24h,
        todayWorkConfirmed: todayWork.filter((r) => confirmed(r.data)).length,
        todayWorkDraft: todayWork.filter((r) => !confirmed(r.data)).length,
        todayDeliveryCount: todayDelivery.length,
        todayDeliveryProducts: todayDelivery.reduce((n, r) => n + new Set(r.data.productIds).size, 0),
        failedDocuments,
      },
      daily,
      attention: attention.slice(0, ATTENTION_MAX),
    };
  }
}
