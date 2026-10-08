/**
 * CHG-001 D7: 遡及マスタ変更の判定（純関数）。
 *  - RULE（rates / transport-rules / fixed-charges）: 変更前後いずれかの適用期間が「今日(JST)」より前に掛かる
 *  - HOLIDAY: 変更前後いずれかの休日日付が今日(JST)より前
 *  - それ以外のマスタ: 遡及扱いしない
 * 遡及の更新・無効化は reason 必須、audit に retroactive=true を記録。確定済み請求 snapshot は変更しない。
 */

export type RetroactiveKind = 'RULE' | 'HOLIDAY' | 'NONE';

export interface DateRange {
  readonly from: string; // YYYY-MM-DD
  readonly to: string | null; // null = 無期限
}

const JST_OFFSET_MS = 9 * 60 * 60_000;

/** 業務日（JST）の YYYY-MM-DD */
export function jstBusinessDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function rangeTouchesBefore(range: DateRange, today: string): boolean {
  return range.from < today;
}

export function isRetroactiveChange(
  kind: RetroactiveKind,
  before: DateRange | null,
  after: DateRange | null,
  today: string,
): boolean {
  if (kind === 'NONE') {
    return false;
  }
  return [before, after].some((range) => range !== null && rangeTouchesBefore(range, today));
}

/** 変更前後の期間を包含する期間（影響範囲の算出用） */
export function unionRange(a: DateRange | null, b: DateRange | null): DateRange | null {
  const ranges = [a, b].filter((r): r is DateRange => r !== null);
  if (ranges.length === 0) {
    return null;
  }
  const from = ranges.map((r) => r.from).sort()[0] as string;
  const to = ranges.some((r) => r.to === null) ? null : (ranges.map((r) => r.to as string).sort().at(-1) as string);
  return { from, to };
}
