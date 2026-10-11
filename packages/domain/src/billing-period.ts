/**
 * 請求・運搬費計算完全仕様書「請求期間・税」: closing_day=31 は月末。対象期間は前締め翌日〜当締め日（両端含む）。
 * CHG-009: 締日がその月に無い（例 30日締めの2月）ときは月末を締め日とする。
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parse(date: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(date);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** その年月の締め日（YYYY-MM-DD） */
export function closingDateOf(year: number, month: number, closingDay: number): string {
  if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) throw new Error(`invalid closingDay: ${closingDay}`);
  return `${year}-${pad(month)}-${pad(Math.min(closingDay, daysInMonth(year, month)))}`;
}

/** 日付に日数を足す（YYYY-MM-DD） */
export function addDays(date: string, days: number): string {
  const p = parse(date);
  if (p === null) throw new Error(`invalid date: ${date}`);
  return new Date(Date.UTC(p.y, p.m - 1, p.d + days)).toISOString().slice(0, 10);
}

export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
}

/**
 * periodEnd がお客様の締め日なら対象期間を返す。締め日でなければ null（422）。
 * 例: 31日締め・2026-08-31 → 2026-08-01〜08-31、20日締め・2026-09-20 → 2026-08-21〜09-20
 */
export function billingPeriodFor(closingDay: number, periodEnd: string): BillingPeriod | null {
  const p = parse(periodEnd);
  if (p === null) return null;
  if (closingDateOf(p.y, p.m, closingDay) !== periodEnd) return null;
  const prevY = p.m === 1 ? p.y - 1 : p.y;
  const prevM = p.m === 1 ? 12 : p.m - 1;
  return { start: addDays(closingDateOf(prevY, prevM, closingDay), 1), end: periodEnd };
}

/** 年月（YYYY-MM）の締め日。画面の初期値に使う */
export function closingDateForMonth(month: string, closingDay: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) throw new Error(`invalid month: ${month}`);
  return closingDateOf(Number(m[1]), Number(m[2]), closingDay);
}

/** 期間の重なり（両端含む。to=null は無期限） */
export function rangesOverlap(a: { from: string; to: string | null }, b: { from: string; to: string | null }): boolean {
  return (a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);
}

/** date が [from, to] に含まれるか（to=null は無期限） */
export function inRange(date: string, from: string, to: string | null): boolean {
  return from <= date && (to === null || date <= to);
}
