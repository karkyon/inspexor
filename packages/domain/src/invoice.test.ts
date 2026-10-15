import { describe, it, expect } from 'vitest';
import {
  adjustmentApplyFrom,
  calculateBilling,
  DEFAULT_INVOICE_ISSUER,
  documentFileName,
  invoiceDisplayNo,
  invoiceDocumentsReady,
  invoiceDueDate,
  invoiceIssuerFromEnv,
  invoiceMailSubject,
  invoicePeriodLabel,
  missingPlaceholders,
  resolveInvoiceAction,
  resolveRecordTransition,
  validateAdjustmentInput,
  type BillingEngineInput,
} from './index';

describe('CHG-011: 請求書の番号・期限・件名', () => {
  it('請求書番号は INV-YYYYMM-お客様コード-3桁の版（用語定義書）', () => {
    expect(invoiceDisplayNo('INV-202610-C1', 1)).toBe('INV-202610-C1-001');
    expect(invoiceDisplayNo('INV-202610-C1', 12)).toBe('INV-202610-C1-012');
    expect(() => invoiceDisplayNo('INV-202610-C1', 0)).toThrow();
    expect(() => invoiceDisplayNo('INV-202610-C1', 1000)).toThrow();
  });

  it('支払期限は締め日の翌月末（うるう年・年跨ぎ）', () => {
    expect(invoiceDueDate('2026-10-31')).toBe('2026-11-30');
    expect(invoiceDueDate('2026-10-20')).toBe('2026-11-30');
    expect(invoiceDueDate('2028-01-31')).toBe('2028-02-29');
    expect(invoiceDueDate('2026-12-31')).toBe('2027-01-31');
  });

  it('件名は【請求書送付】{期間} {請求書番号}（帳票・メール定義書）', () => {
    expect(invoicePeriodLabel('2026-10-31')).toBe('2026年10月分');
    expect(invoiceMailSubject('2026年10月分', 'INV-202610-C1-001')).toBe('【請求書送付】2026年10月分 INV-202610-C1-001');
  });

  it('発行元は既定値に INVOICE_ISSUER_JSON を重ねる（不正な JSON・型は無視）', () => {
    expect(invoiceIssuerFromEnv(undefined)).toEqual(DEFAULT_INVOICE_ISSUER);
    expect(invoiceIssuerFromEnv('{')).toEqual(DEFAULT_INVOICE_ISSUER);
    const i = invoiceIssuerFromEnv(JSON.stringify({ registrationNo: ' T1234567890123 ', bankNote: '〇〇銀行', tel: 1 }));
    expect(i.registrationNo).toBe('T1234567890123');
    expect(i.bankNote).toBe('〇〇銀行');
    expect(i.tel).toBe(DEFAULT_INVOICE_ISSUER.tel);
  });

  it('帳票ファイル名（鏡は「請求書」、明細は「請求明細」）', () => {
    const f = { date: '2026-10-31', customerCode: 'C1', reportNo: 'INV-202610-C1-001', revisionNo: 1 };
    expect(documentFileName('INVOICE_COVER_V1', f)).toBe('請求書_2026-10-31_C1_INV-202610-C1-001_r1.pdf');
    expect(documentFileName('INVOICE_DETAIL_V1', f)).toBe('請求明細_2026-10-31_C1_INV-202610-C1-001_r1.pdf');
  });

  it('必須 placeholder（帳票・メール定義書 §6）', () => {
    expect(missingPlaceholders('{{invoice_no}}{{period}}', 'INVOICE_DETAIL_V1')).toEqual(['customer_name', 'line_rows', 'subtotal', 'tax', 'total']);
    expect(missingPlaceholders('{{issuer}}{{customer}}{{invoice_no}}{{issue_date}}{{due_date}}{{subtotal}}{{tax}}{{total}}{{bank_note}}{{period}}', 'INVOICE_COVER_V1')).toEqual([]);
  });
});

describe('CHG-011: 請求書の操作（resolveInvoiceAction）', () => {
  const base = { status: 'FINALIZED' as const, documents: [null, null], mails: [], reason: null };

  it('発行: 確定済みで帳票未作成（または最終失敗）のときだけ', () => {
    expect(resolveInvoiceAction('issue', base)).toEqual({ ok: true });
    expect(resolveInvoiceAction('issue', { ...base, documents: ['FAILED_FINAL', 'GENERATED'] }).ok).toBe(false);
    expect(resolveInvoiceAction('issue', { ...base, documents: ['FAILED_FINAL', 'FAILED_FINAL'] }).ok).toBe(true);
    expect(resolveInvoiceAction('issue', { ...base, documents: ['QUEUED', null] }).ok).toBe(false);
    expect(resolveInvoiceAction('issue', { ...base, status: 'ISSUED' }).ok).toBe(false);
  });

  it('送付は発行済みで未送信のとき、再送は送信後で理由必須', () => {
    const issued = { ...base, status: 'ISSUED' as const, documents: ['GENERATED', 'GENERATED'] as const };
    expect(resolveInvoiceAction('send', { ...base, documents: [...issued.documents] }).ok).toBe(false);
    expect(resolveInvoiceAction('send', { ...issued, documents: [...issued.documents] })).toEqual({ ok: true });
    expect(resolveInvoiceAction('send', { ...issued, documents: [...issued.documents], mails: ['FAILED_FINAL'] }).ok).toBe(false);
    const r = resolveInvoiceAction('resend', { ...issued, documents: [...issued.documents], mails: ['SENT'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.status, r.path]).toEqual([422, '/reason']);
    expect(resolveInvoiceAction('resend', { ...issued, documents: [...issued.documents], mails: ['SENT'], reason: '宛先追加' })).toEqual({ ok: true });
    expect(resolveInvoiceAction('resend', { ...issued, documents: [...issued.documents], mails: ['SENDING'], reason: 'x' }).ok).toBe(false);
    expect(resolveInvoiceAction('resend', { ...issued, documents: [...issued.documents], reason: 'x' }).ok).toBe(false);
  });

  it('無効化は理由必須、送信中・無効化済みは不可', () => {
    expect(resolveInvoiceAction('void', base).ok).toBe(false);
    expect(resolveInvoiceAction('void', { ...base, reason: '金額誤り' })).toEqual({ ok: true });
    expect(resolveInvoiceAction('void', { ...base, status: 'SENT', mails: ['SENT'], reason: '金額誤り' })).toEqual({ ok: true });
    expect(resolveInvoiceAction('void', { ...base, status: 'ISSUED', mails: ['QUEUED'], reason: 'x' }).ok).toBe(false);
    expect(resolveInvoiceAction('void', { ...base, status: 'VOIDED', reason: 'x' }).ok).toBe(false);
  });

  it('鏡・明細の両方が作成済みなら発行済み', () => {
    expect(invoiceDocumentsReady(['GENERATED', 'GENERATED'])).toBe(true);
    expect(invoiceDocumentsReady(['GENERATED', 'PROCESSING'])).toBe(false);
    expect(invoiceDocumentsReady([])).toBe(false);
  });

  it('請求書の無効化で報告を承認済みに戻す（SYSTEM のみ）', () => {
    expect(resolveRecordTransition('BILLING_LOCKED', 'billingUnlock', { roles: ['SYSTEM'], isOwner: false })).toEqual({ ok: true, to: 'APPROVED' });
    expect(resolveRecordTransition('BILLING_LOCKED', 'billingUnlock', { roles: ['ADMIN'], isOwner: false }).ok).toBe(false);
  });
});

describe('CHG-011: 遅延訂正の調整（FR-019）', () => {
  it('入力: 0 以外の整数円・内容・理由', () => {
    expect(validateAdjustmentInput({ amountYen: -1500, description: '数量訂正', reason: '検品数の誤り' })).toEqual([]);
    expect(validateAdjustmentInput({ amountYen: 0, description: 'x', reason: 'y' }).map((i) => i.path)).toEqual(['/amountYen']);
    expect(validateAdjustmentInput({ amountYen: 1.5, description: ' ', reason: '' }).map((i) => i.path)).toEqual(['/amountYen', '/description', '/reason']);
    expect(validateAdjustmentInput({ amountYen: 100_000_000, description: 'x', reason: 'y' }).map((i) => i.path)).toEqual(['/amountYen']);
  });

  it('次の請求期間から入る（元の締め日の翌日以降）', () => {
    expect(adjustmentApplyFrom('2026-10-31')).toBe('2026-11-01');
    expect(adjustmentApplyFrom('2026-12-31')).toBe('2027-01-01');
  });

  it('計算: 調整は元の請求書番号付きの明細（負も可）。調整が無ければ従来どおり', () => {
    const input: BillingEngineInput = {
      customerId: 'c1', periodStart: '2026-11-01', periodEnd: '2026-11-30',
      products: [{ id: 'p1', code: 'P1', name: '品1', settlementType: 'QUANTITY' }],
      rateRules: [], transportRules: [], fixedCharges: [], work: [], deliveries: [],
    };
    const none = calculateBilling(input);
    expect(none.lines).toHaveLength(0);
    expect(none.adjustmentIds).toEqual([]);
    const r = calculateBilling({ ...input, adjustments: [{ id: 'a2', productId: 'p1', description: '数量訂正', amountYen: -1500, sourceInvoiceNo: 'INV-202610-C1-001', sourceReportNo: 'WR-202610-000003' }, { id: 'a1', productId: 'p1', description: '単価訂正', amountYen: 4000, sourceInvoiceNo: 'INV-202610-C1-001', sourceReportNo: null }] });
    expect(r.lines.map((l) => [l.lineType, l.sourceType, l.amountYen, l.reportId])).toEqual([
      ['ADJUSTMENT', 'ADJUSTMENT', 4000, null],
      ['ADJUSTMENT', 'ADJUSTMENT', -1500, null],
    ]);
    expect(r.lines[1]?.description).toBe('調整 数量訂正（INV-202610-C1-001 の訂正）');
    expect(r.lines[1]?.reportNo).toBe('WR-202610-000003');
    expect([r.subtotalYen, r.taxYen, r.totalYen]).toEqual([2500, 250, 2750]);
    expect(r.adjustmentIds).toEqual(['a1', 'a2']);
    expect(r.warnings).toHaveLength(0);
    const neg = calculateBilling({ ...input, adjustments: [{ id: 'a3', productId: 'p1', description: '返金', amountYen: -100, sourceInvoiceNo: 'INV-202610-C1-001', sourceReportNo: null }] });
    expect(neg.warnings.map((w) => w.code)).toEqual(['NEGATIVE_INVOICE']);
  });
});
