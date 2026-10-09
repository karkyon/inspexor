/** E2E の業務日: JST の今日（現場の実運用と同じ。過去日の報告が増えても「最近の登録」の先頭に来る） */
export const TODAY = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
export const MONTH = TODAY.slice(0, 7);
