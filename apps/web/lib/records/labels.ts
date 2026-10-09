/**
 * 報告（作業日報・運搬実績）の表示用ラベル（現場・事務所で共通）。CHG-004: 承認は使わないため「提出済」が確定後の最終状態。
 */
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  DRAFT: '下書き',
  CONFIRMED: '確定',
  SUBMITTED: '提出済',
  APPROVED: '承認済',
  REJECTED: '差戻し',
  REVOKED: '取消',
  BILLING_LOCKED: '請求確定済',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export const TYPE_LABEL: Readonly<Record<'WORK' | 'DELIVERY', string>> = { WORK: '作業日報', DELIVERY: '運搬実績' };

/** 帳票の状態（G4）。下書きは表示しない */
export function documentStatusLabel(status: string, documentStatus: string | null): string {
  if (status === 'DRAFT') return '—';
  if (documentStatus === 'GENERATED') return '作成済';
  if (documentStatus === 'FAILED_FINAL') return 'エラー';
  return '作成中';
}

export function yenLabel(v: number | null): string {
  return v === null ? '未確定' : `${v.toLocaleString('ja-JP')}円`;
}

/** 確定後修正（CHG-004 D3）を始められる状態（service の REVISABLE_STATUSES と同じ） */
export const REVISABLE: readonly string[] = ['CONFIRMED', 'SUBMITTED', 'REJECTED', 'REVOKED'];

/** JST の今月1日と今日（YYYY-MM-DD） */
export function currentMonthRangeJst(now: Date = new Date()): { from: string; to: string } {
  const jst = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  return { from: `${jst.slice(0, 8)}01`, to: jst };
}
