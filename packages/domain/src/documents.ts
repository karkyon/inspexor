/**
 * G4 帳票・メールの業務規則（帳票・メール定義書 v5.1 / CHG-003）。framework/DB/provider 非依存。
 *  - template: `{{placeholder}}` を HTML エスケープして置換。未置換 `{{...}}` が残れば FAILED_FINAL（TEMPLATE_INVALID）
 *  - 日報: 必須 placeholder、0 不良は「不具合なし」、filename `日報_YYYY-MM-DD_customerCode_reportNo_rN.pdf`
 *  - 運搬（CHG-003）: DELIVERY_REPORT_V1、filename `運搬_YYYY-MM-DD_customerCode_reportNo_rN.pdf`、メール送信なし
 *  - mail: 件名 `【INSPEXOR作業報告】{workDate} {productCode} {reportNo}`、CRLF/header injection 拒否、宛先正規化、20MB
 *  - retry: network/408/429/5xx のみ、10s/30s/2m/10m/30m、最大5回（機能別詳細設計書 §9）
 */

export type TemplateType = 'DAILY_REPORT_V1' | 'DELIVERY_REPORT_V1';

export const DAILY_REPORT_PLACEHOLDERS = [
  'report_no', 'revision_no', 'work_date', 'customer_code', 'customer_name', 'product_code', 'product_name', 'work_type', 'lot_no',
  'reporter_name', 'worker_names', 'start_time', 'end_time', 'break_minutes', 'regular_person_minutes', 'overtime_person_minutes',
  'quantity', 'defect_rows', 'defect_total', 'confirmed_at',
] as const;

/** CHG-003 で定義（運搬実績の帳票） */
export const DELIVERY_REPORT_PLACEHOLDERS = [
  'report_no', 'revision_no', 'delivery_date', 'driver_name', 'customer_code', 'customer_name', 'item_rows', 'item_count', 'total_quantity', 'confirmed_at',
] as const;

export const TEMPLATE_PLACEHOLDERS: Readonly<Record<TemplateType, readonly string[]>> = {
  DAILY_REPORT_V1: DAILY_REPORT_PLACEHOLDERS,
  DELIVERY_REPORT_V1: DELIVERY_REPORT_PLACEHOLDERS,
};

/** 値は HTML エスケープ済みで埋め込む。行（*_rows）だけは呼出側で組んだ安全な HTML を受ける */
export type TemplateValue = string | { readonly html: string };

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function renderTemplate(template: string, values: Readonly<Record<string, TemplateValue>>): string {
  return template.replace(PLACEHOLDER_RE, (whole, key: string) => {
    if (!(key in values)) return whole; // 未置換のまま残し、後段の検査で FAILED_FINAL にする
    const v = values[key] as TemplateValue;
    return typeof v === 'string' ? escapeHtml(v) : v.html;
  });
}

/** 未置換 placeholder（`{{...}}`）。1件でもあれば送信禁止 */
export function findUnresolvedPlaceholders(html: string): string[] {
  return [...new Set([...html.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]))];
}

/** template 原本に必須 placeholder が全てあるか（registry 登録時の検査） */
export function missingPlaceholders(template: string, type: TemplateType): string[] {
  const present = new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
  return TEMPLATE_PLACEHOLDERS[type].filter((p) => !present.has(p));
}

function safeFilePart(value: string): string {
  // filename sanitize（SEC-015）: パス区切り・制御文字・予約文字を除去
  return value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim() || 'x';
}

export function documentFileName(type: TemplateType, input: { date: string; customerCode: string; reportNo: string; revisionNo: number }): string {
  const prefix = type === 'DAILY_REPORT_V1' ? '日報' : '運搬';
  return `${prefix}_${safeFilePart(input.date)}_${safeFilePart(input.customerCode)}_${safeFilePart(input.reportNo)}_r${input.revisionNo}.pdf`;
}

export function dailyReportSubject(input: { workDate: string; productCode: string; reportNo: string }): string {
  return `【INSPEXOR作業報告】${input.workDate} ${input.productCode} ${input.reportNo}`;
}

/** 分 → 「H時間M分」（日本語/整数分） */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}時間${m > 0 ? `${m}分` : ''}` : `${m}分`;
}

/**
 * CHG-004（提案書 SK-2026-08-MINI を正本化）: 日報メールの自動送信は対象外。
 * 機能は残すが既定で無効（環境変数 DAILY_MAIL_ENABLED=true のときだけ動く。画面にも出さない）
 */
export function isDailyMailEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export const MAIL_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAIL_MAX_ATTACHMENTS = 2;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function hasHeaderInjection(value: string): boolean {
  return /[\r\n\u0000]/.test(value);
}

export type RecipientCheck =
  | { readonly ok: true; readonly recipients: string[] }
  | { readonly ok: false; readonly code: 'RECIPIENT_EMPTY' | 'RECIPIENT_INVALID'; readonly detail: string };

/** 宛先の正規化（小文字・trim・重複除去）と検査（0件 / 不正 email / CRLF は FAILED_FINAL） */
export function normalizeRecipients(raw: readonly string[]): RecipientCheck {
  const out: string[] = [];
  for (const r of raw) {
    if (hasHeaderInjection(r)) return { ok: false, code: 'RECIPIENT_INVALID', detail: 'header injection' };
    const e = r.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, code: 'RECIPIENT_INVALID', detail: 'invalid email' };
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0) return { ok: false, code: 'RECIPIENT_EMPTY', detail: 'no recipients' };
  return { ok: true, recipients: out };
}

/** 環境変数台帳 JOB_MAX_ATTEMPTS=5（retry 最大5回 = 初回＋5回、遅延 10s/30s/2m/10m/30m を1回ずつ使う） */
export const JOB_MAX_RETRIES = 5;
export const JOB_RETRY_DELAYS_SECONDS: readonly number[] = [10, 30, 120, 600, 1800];

/** 失敗の分類: network/408/429/5xx は retry、それ以外（業務検証・placeholder・宛先）は final */
export function isRetryableFailure(failure: { readonly network?: boolean; readonly httpStatus?: number }): boolean {
  if (failure.network === true) return true;
  const s = failure.httpStatus;
  return s === 408 || s === 429 || (s !== undefined && s >= 500 && s <= 599);
}

export type JobOutcome =
  | { readonly status: 'FAILED_RETRYABLE'; readonly nextAttemptAfterSeconds: number }
  | { readonly status: 'FAILED_FINAL' };

/** attempts = 今回を含む試行回数（1始まり）。retry 済み回数 = attempts - 1 */
export function decideRetry(attempts: number, retryable: boolean): JobOutcome {
  if (!retryable || attempts - 1 >= JOB_MAX_RETRIES) return { status: 'FAILED_FINAL' };
  return { status: 'FAILED_RETRYABLE', nextAttemptAfterSeconds: JOB_RETRY_DELAYS_SECONDS[attempts - 1] ?? 1800 };
}
