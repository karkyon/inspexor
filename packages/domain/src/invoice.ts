/**
 * CHG-011 請求書（FR-013 請求書PDF・FR-014 請求配信・FR-019 遅延訂正 / SCR-15 / API-022・023・035〜037）。framework/DB 非依存。
 *
 *  請求書番号: 用語定義書 `INV-YYYYMM-customerCode-3桁revision`。保存は版なしの基本番号（INV-YYYYMM-code）と版（revision）
 *  状態: FINALIZED（確定）─issue→（PDF 作成）─issued(SYSTEM)→ ISSUED ─send→（送信）─mailSent(SYSTEM)→ SENT
 *        FINALIZED / ISSUED / SENT ─void（理由必須）→ VOIDED（請求 run も取消、報告は承認済みに戻り、同じ期間を作り直せる。版+1）
 *        resend（理由必須）は ISSUED / SENT で、前回の送信の後に新しい送信（sendRevision+1）
 *  遅延訂正（業務要件 §8-4・DEC-004）: 確定した請求書は変更しない。差額は「調整」として登録し、次の請求期間の明細に入れる
 *  支払期限: 請求期間の締め日の翌月末（CHG-011 の決定。お客様マスタに支払条件が無いため）
 */

export type InvoiceStatus = 'FINALIZED' | 'ISSUED' | 'SENT' | 'VOIDED';
export type InvoiceAction = 'issue' | 'send' | 'resend' | 'void';
export const INVOICE_ACTIONS: readonly InvoiceAction[] = ['issue', 'send', 'resend', 'void'];

export type InvoiceJobStatus = 'QUEUED' | 'PROCESSING' | 'GENERATED' | 'SENDING' | 'SENT' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';

/** 版付きの請求書番号（帳票・メール・画面の表示） */
export function invoiceDisplayNo(baseNo: string, revision: number): string {
  if (!Number.isInteger(revision) || revision < 1 || revision > 999) throw new Error(`invoice revision out of range: ${revision}`);
  return `${baseNo}-${String(revision).padStart(3, '0')}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 支払期限: 締め日の翌月末 */
export function invoiceDueDate(periodEnd: string): string {
  const m = DATE_RE.exec(periodEnd);
  if (m === null) throw new Error(`invalid date: ${periodEnd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo + 1, 0));
  return last.toISOString().slice(0, 10);
}

/** 件名・帳票の対象期間の表記: 締め日の年月（例 2026年10月分） */
export function invoicePeriodLabel(periodEnd: string): string {
  const m = DATE_RE.exec(periodEnd);
  if (m === null) throw new Error(`invalid date: ${periodEnd}`);
  return `${Number(m[1])}年${Number(m[2])}月分`;
}

/** 帳票・メール定義書: 請求 = `【請求書送付】{periodLabel} {invoiceNo}` */
export function invoiceMailSubject(periodLabel: string, displayNo: string): string {
  return `【請求書送付】${periodLabel} ${displayNo}`;
}

/** 発行元（請求書の鏡）。発行時に請求書へ snapshot する */
export interface InvoiceIssuer {
  readonly name: string;
  readonly postalCode: string;
  readonly address: string;
  readonly tel: string;
  readonly fax: string;
  readonly email: string;
  /** 適格請求書発行事業者の登録番号（T+13桁）。未設定なら空 */
  readonly registrationNo: string;
  /** 振込先などの注記（鏡の下部） */
  readonly bankNote: string;
}

/**
 * 既定の発行元。電話・FAX・メールは現行の作業結果報告書の記載（CHG-005）。
 * 住所・登録番号・振込先はお客様の確認待ち（CHG-011 §6）のため空。本番は INVOICE_ISSUER_JSON で設定する
 */
export const DEFAULT_INVOICE_ISSUER: InvoiceIssuer = {
  name: '三成興業株式会社',
  postalCode: '',
  address: '',
  tel: '086-448-1930',
  fax: '086-448-1936',
  email: 'sansei0112@nifty.com',
  registrationNo: '',
  bankNote: '',
};

const ISSUER_KEYS: ReadonlyArray<keyof InvoiceIssuer> = ['name', 'postalCode', 'address', 'tel', 'fax', 'email', 'registrationNo', 'bankNote'];

/** INVOICE_ISSUER_JSON（{"name": …} の一部だけでも可）を既定値に重ねる。不正な JSON・型は無視して既定値 */
export function invoiceIssuerFromEnv(raw: string | undefined): InvoiceIssuer {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INVOICE_ISSUER;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = { ...DEFAULT_INVOICE_ISSUER };
    for (const k of ISSUER_KEYS) {
      const v = parsed[k];
      if (typeof v === 'string') out[k] = v.trim().slice(0, 500);
    }
    return out as unknown as InvoiceIssuer;
  } catch {
    return DEFAULT_INVOICE_ISSUER;
  }
}

export interface InvoiceActionState {
  readonly status: InvoiceStatus;
  /** 鏡・明細の帳票 job の状態（未作成は null） */
  readonly documents: readonly (InvoiceJobStatus | null)[];
  /** 送信（mail job）の状態。古い順 */
  readonly mails: readonly InvoiceJobStatus[];
  /** 理由（resend・void は必須） */
  readonly reason: string | null;
}

export type InvoiceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 409 | 422; readonly code: 'STATE_CONFLICT' | 'VALIDATION_ERROR'; readonly path: string; readonly message: string };

const IN_FLIGHT: readonly InvoiceJobStatus[] = ['QUEUED', 'PROCESSING', 'SENDING', 'FAILED_RETRYABLE'];

/** 操作できるか（状態・帳票・送信・理由）。権限（OFFICE/ADMIN）は API の入口で確認済み */
export function resolveInvoiceAction(action: InvoiceAction, s: InvoiceActionState): InvoiceActionResult {
  const conflict = (message: string): InvoiceActionResult => ({ ok: false, status: 409, code: 'STATE_CONFLICT', path: '/status', message });
  const reasonRequired = (label: string): InvoiceActionResult => ({ ok: false, status: 422, code: 'VALIDATION_ERROR', path: '/reason', message: `${label}の理由を入力してください。` });
  const hasReason = s.reason !== null && s.reason.trim() !== '';
  const docsBusy = s.documents.some((d) => d !== null && IN_FLIGHT.includes(d));
  const mailBusy = s.mails.some((m) => IN_FLIGHT.includes(m));
  switch (action) {
    case 'issue': {
      if (s.status !== 'FINALIZED') return conflict('発行できるのは確定済み（未発行）の請求書だけです。');
      if (docsBusy) return conflict('請求書PDFを作成中です。');
      const allFailedOrNone = s.documents.every((d) => d === null || d === 'FAILED_FINAL');
      if (!allFailedOrNone) return conflict('請求書PDFは作成済みです。');
      return { ok: true };
    }
    case 'send': {
      if (s.status !== 'ISSUED' && s.status !== 'SENT') return conflict('送付できるのは発行済みの請求書だけです。');
      if (mailBusy) return conflict('送信中です。完了後に操作してください。');
      if (s.mails.length > 0) return conflict('送信済みです。もう一度送る場合は再送（理由必須）を使ってください。');
      return { ok: true };
    }
    case 'resend': {
      if (s.status !== 'ISSUED' && s.status !== 'SENT') return conflict('再送できるのは発行済みの請求書だけです。');
      if (mailBusy) return conflict('送信中です。完了後に操作してください。');
      if (s.mails.length === 0) return conflict('まだ送信していません。送付を使ってください。');
      if (!hasReason) return reasonRequired('再送');
      return { ok: true };
    }
    case 'void': {
      if (s.status === 'VOIDED') return conflict('この請求書は無効化済みです。');
      if (mailBusy) return conflict('送信中は無効化できません。完了後に操作してください。');
      if (!hasReason) return reasonRequired('無効化');
      return { ok: true };
    }
  }
}

/** 鏡・明細の両方が作成済みなら発行済み（ISSUED）にする */
export function invoiceDocumentsReady(documents: readonly (InvoiceJobStatus | null)[]): boolean {
  return documents.length > 0 && documents.every((d) => d === 'GENERATED');
}

// ---------------------------------------------------------------- 調整（遅延訂正、FR-019）

export type AdjustmentStatus = 'PENDING' | 'APPLIED' | 'CANCELLED';
export const ADJUSTMENT_AMOUNT_MAX = 99_999_999;
export const ADJUSTMENT_DESCRIPTION_MAX = 200;

export interface AdjustmentIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** 調整額は 0 以外の整数円（負は値引き・返金）。説明・理由は必須 */
export function validateAdjustmentInput(input: { amountYen: number; description: string; reason: string }): AdjustmentIssue[] {
  const issues: AdjustmentIssue[] = [];
  if (!Number.isSafeInteger(input.amountYen) || input.amountYen === 0 || Math.abs(input.amountYen) > ADJUSTMENT_AMOUNT_MAX) {
    issues.push({ path: '/amountYen', code: 'range', message: `調整額は 0 以外の整数円（±${ADJUSTMENT_AMOUNT_MAX.toLocaleString('ja-JP')}円まで）で入力してください。` });
  }
  const d = input.description.trim();
  if (d === '' || d.length > ADJUSTMENT_DESCRIPTION_MAX) issues.push({ path: '/description', code: 'range', message: `内容は1〜${ADJUSTMENT_DESCRIPTION_MAX}文字で入力してください。` });
  if (input.reason.trim() === '') issues.push({ path: '/reason', code: 'required', message: '調整の理由を入力してください。' });
  return issues;
}

/** 調整を入れる最初の請求期間: 元の請求書の締め日の翌日以降に締める請求 */
export function adjustmentApplyFrom(sourcePeriodEnd: string): string {
  const m = DATE_RE.exec(sourcePeriodEnd);
  if (m === null) throw new Error(`invalid date: ${sourcePeriodEnd}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

/** 金額の表記（帳票・メール）: 桁区切りの整数円 */
export function yenLabel(amount: number): string {
  return `${amount < 0 ? '−' : ''}${Math.abs(amount).toLocaleString('ja-JP')}`;
}
