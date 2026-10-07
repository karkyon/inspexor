/**
 * INSPEXOR_請求・運搬費計算完全仕様書_v5.1.md 「時間」節、decision table準拠。
 * 00契約 不変条件6: UI入力は5分刻み、保存は整数分。12:00-13:00重複控除。
 * 平日17:00以降と土日祝は1.25倍対象（倍率自体はrate-calculation.tsが適用）、重複加算なし。
 */

const BREAK_START = 12 * 60;
const BREAK_END = 13 * 60;
const OVERTIME_BOUNDARY = 17 * 60;
const DAY_START = 0;
const DAY_END = 24 * 60;

export interface BusinessTimeInput {
  /** JST業務日 YYYY-MM-DD */
  date: string;
  /** HH:MM, 5分刻み */
  start: string;
  /** HH:MM, 5分刻み, endExclusive, end > start */
  end: string;
  workers: number;
  /** holidays masterに該当する場合true。省略時は曜日のみで判定（土日=true） */
  isHoliday?: boolean;
}

export interface BusinessTimeResult {
  breakMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularPersonMinutes: number;
  overtimePersonMinutes: number;
}

function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`invalid time format: ${value}`);
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 24 || mm < 0 || mm >= 60 || mm % 5 !== 0) {
    throw new Error(`time must be 5-minute increments within a day: ${value}`);
  }
  return hh * 60 + mm;
}

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

function isWeekend(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`invalid date format: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function computeBusinessTime(input: BusinessTimeInput): BusinessTimeResult {
  const spanStart = parseHHMM(input.start);
  const spanEnd = parseHHMM(input.end);
  if (spanEnd <= spanStart) {
    throw new Error('end must be after start');
  }
  if (spanEnd - spanStart >= DAY_END) {
    throw new Error('span must be less than 24 hours');
  }
  if (!Number.isInteger(input.workers) || input.workers <= 0) {
    throw new Error('workers must be a positive integer');
  }

  const offDay = (input.isHoliday ?? false) || isWeekend(input.date);
  const breakOverlap = overlapMinutes(spanStart, spanEnd, BREAK_START, BREAK_END);

  let regularMinutes: number;
  let overtimeMinutes: number;

  if (offDay) {
    const totalRaw = overlapMinutes(spanStart, spanEnd, DAY_START, DAY_END);
    regularMinutes = 0;
    overtimeMinutes = totalRaw - breakOverlap;
  } else {
    const regularRaw = overlapMinutes(spanStart, spanEnd, DAY_START, OVERTIME_BOUNDARY);
    const overtimeRaw = overlapMinutes(spanStart, spanEnd, OVERTIME_BOUNDARY, DAY_END);
    regularMinutes = regularRaw - breakOverlap;
    overtimeMinutes = overtimeRaw;
  }

  return {
    breakMinutes: breakOverlap,
    regularMinutes,
    overtimeMinutes,
    regularPersonMinutes: regularMinutes * input.workers,
    overtimePersonMinutes: overtimeMinutes * input.workers,
  };
}
