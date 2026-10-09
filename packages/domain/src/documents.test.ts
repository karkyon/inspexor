import { describe, it, expect } from 'vitest';
import {
  DAILY_REPORT_PLACEHOLDERS,
  DAILY_REPORT_V2_PLACEHOLDERS,
  hoursLabel,
  jaClock,
  toWareki,
  dailyReportSubject,
  decideRetry,
  documentFileName,
  escapeHtml,
  findUnresolvedPlaceholders,
  formatMinutes,
  hasHeaderInjection,
  isRetryableFailure,
  missingPlaceholders,
  normalizeRecipients,
  renderTemplate,
} from './index';

describe('template 置換（T-DOC-001: placeholder 残存は FAILED_FINAL）', () => {
  it('値は HTML エスケープ、行 HTML はそのまま、未定義は残る', () => {
    const html = renderTemplate('<p>{{name}}</p><table>{{rows}}</table>{{ missing }}', { name: '<b>山田&"\'</b>', rows: { html: '<tr><td>1</td></tr>' } });
    expect(html).toBe('<p>&lt;b&gt;山田&amp;&quot;&#39;&lt;/b&gt;</p><table><tr><td>1</td></tr></table>{{ missing }}');
    expect(findUnresolvedPlaceholders(html)).toEqual(['{{ missing }}']);
  });
  it('値の中に {{x}} があっても再置換しない（エスケープ後の文字列として残る→検出される）', () => {
    const html = renderTemplate('{{a}}', { a: '{{b}}' });
    expect(findUnresolvedPlaceholders(html)).toEqual(['{{b}}']);
  });
  it('必須 placeholder の欠落検出', () => {
    const all = DAILY_REPORT_PLACEHOLDERS.map((p) => `{{${p}}}`).join('');
    expect(missingPlaceholders(all, 'DAILY_REPORT_V1')).toEqual([]);
    expect(missingPlaceholders(all.replace('{{lot_no}}', ''), 'DAILY_REPORT_V1')).toEqual(['lot_no']);
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });
});

describe('ファイル名・件名・書式', () => {
  it('日報 / 運搬（CHG-003）のファイル名、危険文字は除去', () => {
    expect(documentFileName('DAILY_REPORT_V1', { date: '2026-10-08', customerCode: 'C/01', reportNo: 'WR-202610-000001', revisionNo: 1 })).toBe('日報_2026-10-08_C01_WR-202610-000001_r1.pdf');
    expect(documentFileName('DELIVERY_REPORT_V1', { date: '2026-10-08', customerCode: 'SYN-C01', reportNo: 'DR-202610-000002', revisionNo: 2 })).toBe('運搬_2026-10-08_SYN-C01_DR-202610-000002_r2.pdf');
  });
  it('日報メール件名', () => {
    expect(dailyReportSubject({ workDate: '2026-10-08', productCode: 'SYN-P05', reportNo: 'WR-202610-000001' })).toBe('【INSPEXOR作業報告】2026-10-08 SYN-P05 WR-202610-000001');
  });
  it('分の表示', () => {
    expect(formatMinutes(0)).toBe('0分');
    expect(formatMinutes(60)).toBe('1時間');
    expect(formatMinutes(485)).toBe('8時間5分');
  });
});

describe('宛先（SEC-016）', () => {
  it('正規化（小文字・trim・重複除去）', () => {
    expect(normalizeRecipients([' A@Example.com', 'a@example.com', 'b@example.com'])).toEqual({ ok: true, recipients: ['a@example.com', 'b@example.com'] });
  });
  it('0件・不正・CRLF は final', () => {
    expect(normalizeRecipients([])).toMatchObject({ ok: false, code: 'RECIPIENT_EMPTY' });
    expect(normalizeRecipients(['x'])).toMatchObject({ ok: false, code: 'RECIPIENT_INVALID' });
    expect(normalizeRecipients(['a@example.com\r\nBcc: z@evil.com'])).toMatchObject({ ok: false, code: 'RECIPIENT_INVALID' });
    expect(hasHeaderInjection('件名\n')).toBe(true);
  });
});

describe('retry（network/408/429/5xx のみ、10s/30s/2m/10m/30m、最大5回）', () => {
  it('分類', () => {
    expect(isRetryableFailure({ network: true })).toBe(true);
    for (const s of [408, 429, 500, 503]) expect(isRetryableFailure({ httpStatus: s })).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableFailure({ httpStatus: s })).toBe(false);
    expect(isRetryableFailure({})).toBe(false);
  });
  it('遅延と上限', () => {
    expect([1, 2, 3, 4, 5].map((a) => decideRetry(a, true))).toEqual([10, 30, 120, 600, 1800].map((s) => ({ status: 'FAILED_RETRYABLE', nextAttemptAfterSeconds: s })));
    expect(decideRetry(6, true)).toEqual({ status: 'FAILED_FINAL' });
    expect(decideRetry(1, false)).toEqual({ status: 'FAILED_FINAL' });
  });
});

describe('CHG-005: 作業結果報告書（V2）の表示部品', () => {
  it('和暦・曜日（令和元年・平成）', () => {
    expect(toWareki('2026-06-02').text).toBe('令和 8 年 6 月 2 日（火）');
    expect(toWareki('2019-05-01').text).toBe('令和 元 年 5 月 1 日（水）');
    expect(toWareki('2019-04-30').text).toBe('平成 31 年 4 月 30 日（火）');
    expect(() => toWareki('x')).toThrow();
  });
  it('時間（H）と時刻表記', () => {
    expect(hoursLabel(115)).toBe('1.92');
    expect(hoursLabel(230)).toBe('3.83');
    expect(hoursLabel(0)).toBe('0.00');
    expect(jaClock('09:30')).toBe('9時30分');
    expect(jaClock('24:00')).toBe('24時00分');
  });
  it('V2 の必須 placeholder と日報ファイル名', () => {
    const all = DAILY_REPORT_V2_PLACEHOLDERS.map((p) => `{{${p}}}`).join('');
    expect(missingPlaceholders(all, 'DAILY_REPORT_V2')).toEqual([]);
    expect(documentFileName('DAILY_REPORT_V2', { date: '2026-06-02', customerCode: 'C1', reportNo: 'WR-202606-000001', revisionNo: 2 })).toBe('日報_2026-06-02_C1_WR-202606-000001_r2.pdf');
  });
});
