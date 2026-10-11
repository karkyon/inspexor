/**
 * 報告（作業日報・運搬実績）の文書形（CHG-006 §3）。web（入力・一覧・月次）と worker（帳票）で共有する。
 *
 *  workReports/{reportId}                    ヘッダ＋一覧用の要約（最新の版）＋月次用の要約（確定済みの現在版 current）
 *  workReports/{reportId}/revisions/{revId}  版（PostgreSQL の revision＋作業者・不良、確定後は書き換えない）
 *  deliveryReports/... も同じ形（明細は版の items、運搬費はヘッダ）
 */
import { C } from './repos';

export type ReportType = 'WORK' | 'DELIVERY';

export const REPORT_COLLECTION: Readonly<Record<ReportType, string>> = { WORK: C.workReports, DELIVERY: C.deliveryReports };

export function reportPath(type: ReportType, reportId: string): string {
  return `${REPORT_COLLECTION[type]}/${reportId}`;
}

export function revisionCollection(type: ReportType, reportId: string): string {
  return `${reportPath(type, reportId)}/revisions`;
}

export function revisionPath(type: ReportType, reportId: string, revisionId: string): string {
  return `${revisionCollection(type, reportId)}/${revisionId}`;
}

/** 月次集計用: 確定済みの現在版の要約（作業） */
export interface WorkCurrent {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly businessDate: string;
  readonly customerId: string;
  readonly productId: string;
  readonly workTypeId: string;
  readonly quantity: number;
  readonly defectQuantity: number;
  readonly actualMinutes: number;
  readonly personMinutes: number;
}

/** 月次集計用: 確定済みの現在版の要約（運搬）。明細は品番コード順 */
export interface DeliveryCurrent {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly businessDate: string;
  readonly customerId: string;
  readonly tripCount: number;
  readonly items: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>;
}

export interface ReportHeaderDoc {
  readonly reportNo: string;
  readonly status: string;
  readonly ownerId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly latestRevisionId: string;
  readonly latestRevisionNo: number;
  /** 確定済みの現在版（PostgreSQL の current_revision_id） */
  readonly currentRevisionId: string | null;
  // ---- 一覧用の要約（最新の版）
  readonly businessDate: string;
  readonly customerId: string;
  readonly productIds: readonly string[];
  readonly quantity: number;
  readonly tripCount: number | null;
  /** 運搬費（運搬報告1件に1金額、D2）。作業日報は null */
  readonly deliveryFeeYen: number | null;
  // ---- マスタの参照数（影響 preview）用の要約（最新の版）
  readonly workerIds: readonly string[];
  readonly vehicleId: string | null;
  readonly workLocationId: string | null;
  readonly defectTypeIds: readonly string[];
  // ---- 最新の版の最新帳票（worker が更新）
  readonly documentId: string | null;
  readonly documentStatus: string | null;
  // ---- 月次集計用
  readonly current: WorkCurrent | DeliveryCurrent | null;
}

export interface WorkRevisionDoc {
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly confirmedAt: Date | null;
  readonly workDate: string;
  readonly reporterId: string;
  readonly customerId: string;
  readonly productId: string;
  readonly workTypeId: string;
  readonly lotNo: string | null;
  /** 作業者コード順 */
  readonly workerIds: readonly string[];
  readonly startAt: Date;
  readonly endAt: Date;
  readonly breakMinutes: number;
  readonly regularMinutes: number;
  readonly overtimeMinutes: number;
  readonly regularPersonMinutes: number;
  readonly overtimePersonMinutes: number;
  readonly quantity: number;
  /** 不良種の並び順（sortOrder, code） */
  readonly defects: ReadonlyArray<{ readonly defectTypeId: string; readonly quantity: number }>;
  readonly workLocationId: string | null;
  readonly vehicleId: string | null;
  readonly remarks: string | null;
}

export interface DeliveryRevisionDoc {
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly confirmedAt: Date | null;
  readonly deliveryDate: string;
  readonly driverId: string;
  readonly customerId: string;
  readonly vehicleId: string | null;
  readonly tripCount: number;
  /** 品番コード順。allocationEligible は請求（Blind）用のため常に false（CHG-006 F1） */
  readonly items: ReadonlyArray<{ readonly productId: string; readonly quantity: number; readonly allocationEligible: boolean }>;
}
