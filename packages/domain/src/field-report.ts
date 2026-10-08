/**
 * G3 現場入力（運搬3 step / 作業5 step）の業務規則（framework/DB 非依存）。
 *  - 時間: 請求・運搬費計算完全仕様書 §時間「JST同一業務日 [start,end)、5分刻み、end>start、日跨ぎ不可」
 *  - 報告番号: 用語定義書 format `WR|DR-YYYYMM-6桁sequence`、YYYYMM は作成日（JST）の月（CHG-002 §2.3）
 *  - 画面上限: 画面外部仕様 SCR-04/08/09（作業者 1–50、数量 0/1–999999、不良 0–数量）
 *  - 運搬明細: 業務要件 REQ-DLV-001「重複品番はUIで統合」
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export const FIELD_WORKERS_MAX = 50;
export const FIELD_QUANTITY_MAX = 999_999;
export const TIME_STEP_MINUTES = 5;

export type ReportKind = 'WR' | 'DR';

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** UTC instant → JST の日付・時刻（秒以下も返す） */
export function toJstParts(instant: Date): { date: string; time: string; minutes: number; subMinuteMs: number } {
  const shifted = new Date(instant.getTime() + JST_OFFSET_MS);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { date, time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`, minutes, subMinuteMs: shifted.getUTCSeconds() * 1000 + shifted.getUTCMilliseconds() };
}

/** JST業務日 + HH:MM（'24:00' は翌日0:00）→ UTC ISO 文字列 */
export function jstToInstant(date: string, time: string): string {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (d === null || t === null) throw new Error(`invalid date/time: ${date} ${time}`);
  const hh = Number(t[1]);
  const mm = Number(t[2]);
  if (hh > 24 || mm >= 60 || (hh === 24 && mm !== 0)) throw new Error(`invalid time: ${time}`);
  const utc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hh, mm) - JST_OFFSET_MS;
  return new Date(utc).toISOString();
}

/** JST の業務日（YYYY-MM-DD） */
export function jstBusinessDateOf(instant: Date): string {
  return toJstParts(instant).date;
}

function addDays(date: string, days: number): string {
  const d = DATE_RE.exec(date);
  if (d === null) throw new Error(`invalid date: ${date}`);
  const t = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days));
  return t.toISOString().slice(0, 10);
}

export type WorkSpanResult =
  | { readonly ok: true; readonly start: string; readonly end: string }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/**
 * 作業時間の検証。startAt/endAt（UTC）を JST に直し、作業日内・5分刻み・end>start・日跨ぎ不可を検査する。
 * 成功時は computeBusinessTime 用の 'HH:MM'（終了が翌日0:00なら '24:00'）を返す。
 */
export function validateWorkSpan(workDate: string, startAt: Date, endAt: Date): WorkSpanResult {
  const issues: FieldIssue[] = [];
  const s = toJstParts(startAt);
  const e = toJstParts(endAt);
  if (s.date !== workDate) {
    issues.push({ path: '/startAt', code: 'date_mismatch', message: '開始時刻は作業日（日本時間）の時刻を指定してください。' });
  }
  if (s.subMinuteMs !== 0 || s.minutes % TIME_STEP_MINUTES !== 0) {
    issues.push({ path: '/startAt', code: 'step', message: '開始時刻は5分刻みで入力してください。' });
  }
  if (e.subMinuteMs !== 0 || e.minutes % TIME_STEP_MINUTES !== 0) {
    issues.push({ path: '/endAt', code: 'step', message: '終了時刻は5分刻みで入力してください。' });
  }
  let endTime = e.time;
  if (e.date === workDate) {
    // 同日内
  } else if (e.date === addDays(workDate, 1) && e.minutes === 0) {
    endTime = '24:00';
  } else {
    issues.push({ path: '/endAt', code: 'cross_day', message: '日をまたぐ作業は入力できません（終了は翌日0:00まで）。' });
  }
  if (endAt.getTime() <= startAt.getTime()) {
    issues.push({ path: '/endAt', code: 'order', message: '終了時刻は開始時刻より後にしてください。' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, start: s.time, end: endTime };
}

/** 報告番号の月（作成日 JST の YYYYMM） */
export function reportMonthOf(createdAt: Date): string {
  const p = toJstParts(createdAt);
  return p.date.slice(0, 4) + p.date.slice(5, 7);
}

export function formatReportNo(kind: ReportKind, yyyymm: string, sequence: number): string {
  if (!/^\d{6}$/.test(yyyymm)) throw new Error(`invalid yyyymm: ${yyyymm}`);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999_999) throw new Error(`sequence out of range: ${sequence}`);
  return `${kind}-${yyyymm}-${pad(sequence, 6)}`;
}

/** 同種・同月の既存最大番号（無ければ null）から次番号を作る */
export function nextReportNo(kind: ReportKind, createdAt: Date, currentMax: string | null): string {
  const month = reportMonthOf(createdAt);
  if (currentMax === null) return formatReportNo(kind, month, 1);
  const m = /^(WR|DR)-(\d{6})-(\d{6})$/.exec(currentMax);
  if (m === null || m[1] !== kind || m[2] !== month) throw new Error(`unexpected report no: ${currentMax}`);
  return formatReportNo(kind, month, Number(m[3]) + 1);
}

/** 重複品番の明細を統合（数量合算、最初の出現順を維持） */
export function mergeDeliveryItems<T extends { readonly productId: string; readonly quantity: number }>(
  items: readonly T[],
): Array<{ productId: string; quantity: number }> {
  const order: string[] = [];
  const sums = new Map<string, number>();
  for (const item of items) {
    if (!sums.has(item.productId)) order.push(item.productId);
    sums.set(item.productId, (sums.get(item.productId) ?? 0) + item.quantity);
  }
  return order.map((productId) => ({ productId, quantity: sums.get(productId) ?? 0 }));
}

/** 運搬明細の業務検証（数量 1–999999、品番重複なし） */
export function validateDeliveryItems(items: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (item.quantity < 1 || item.quantity > FIELD_QUANTITY_MAX) {
      issues.push({ path: `/items/${i}/quantity`, code: 'range', message: `数量は1〜${FIELD_QUANTITY_MAX.toLocaleString('ja-JP')}で入力してください。` });
    }
    if (seen.has(item.productId)) {
      issues.push({ path: `/items/${i}/productId`, code: 'duplicate', message: '同じ品番が重複しています。1行にまとめてください。' });
    }
    seen.add(item.productId);
  });
  return issues;
}

/** 作業の数量・作業者・不良の業務検証 */
export function validateWorkQuantities(input: {
  readonly quantity: number;
  readonly workerIds: readonly string[];
  readonly defects: ReadonlyArray<{ readonly defectTypeId: string; readonly quantity: number }>;
}): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (input.quantity > FIELD_QUANTITY_MAX) {
    issues.push({ path: '/quantity', code: 'range', message: `数量は0〜${FIELD_QUANTITY_MAX.toLocaleString('ja-JP')}で入力してください。` });
  }
  if (input.workerIds.length > FIELD_WORKERS_MAX) {
    issues.push({ path: '/workerIds', code: 'range', message: `作業者は${FIELD_WORKERS_MAX}名までです。` });
  }
  const seen = new Set<string>();
  let total = 0;
  input.defects.forEach((d, i) => {
    if (seen.has(d.defectTypeId)) {
      issues.push({ path: `/defects/${i}/defectTypeId`, code: 'duplicate', message: '同じ不良種別が重複しています。' });
    }
    seen.add(d.defectTypeId);
    total += d.quantity;
  });
  if (total > input.quantity) {
    issues.push({ path: '/defects', code: 'exceeds_quantity', message: '不良数の合計が数量を超えています。' });
  }
  return issues;
}
