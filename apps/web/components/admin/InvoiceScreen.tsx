'use client';

/**
 * CHG-011 SCR-15 請求書（BILLING_ENABLED のときだけ。OFFICE/ADMIN が操作、AUDITOR は参照）。
 *  - 発行: 鏡・明細の PDF を作る（API-023 issue）。作成中は自動で再読込
 *  - 送付・再送（理由必須）: 送付先はお客様担当者のうち「請求書メール」が有効な人（API-023 send / resend）
 *  - 無効化（理由必須）: 請求も取り消し、対象の報告は承認済みに戻る。同じ期間を作り直すと版が1つ上がる（API-023 void）
 *  - 遅延訂正: 確定した請求書は変えず、差額を「調整」として登録し、次の請求に入れる（API-035〜037）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest, type ApiError } from '../../lib/api/client';
import { newIdempotencyKey } from '../field/FieldParts';
import { useAdminUser } from './AdminShell';
import { useLookups } from './useLookups';

type InvoiceStatus = 'FINALIZED' | 'ISSUED' | 'SENT' | 'VOIDED';

interface Issuer {
  readonly name: string;
  readonly postalCode: string;
  readonly address: string;
  readonly tel: string;
  readonly fax: string;
  readonly email: string;
  readonly registrationNo: string;
  readonly bankNote: string;
}

interface DocView {
  readonly kind: 'COVER' | 'DETAIL';
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly fileName: string | null;
  readonly url: string | null;
}

interface MailView {
  readonly id: string;
  readonly sendRevision: number;
  readonly status: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly errorCode: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Adjustment {
  readonly id: string;
  readonly sourceInvoiceId: string;
  readonly sourceInvoiceNo: string;
  readonly applyFrom: string;
  readonly sourceReportId: string | null;
  readonly sourceReportNo: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly description: string;
  readonly amountYen: number;
  readonly reason: string;
  readonly status: 'PENDING' | 'APPLIED' | 'CANCELLED';
  readonly version: number;
  readonly appliedInvoiceId: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: string;
}

interface Line {
  readonly no: number;
  readonly lineType: string;
  readonly sourceType: string;
  readonly reportId: string | null;
  readonly reportNo: string | null;
  readonly businessDate: string | null;
  readonly productCode: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly multiplier: string | null;
  readonly amountYen: number;
}

interface Invoice {
  readonly id: string;
  readonly invoiceNo: string;
  readonly revision: number;
  readonly status: InvoiceStatus;
  readonly version: number;
  readonly billingRunId: string;
  readonly customer: { readonly id: string; readonly code: string; readonly name: string };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodLabel: string;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly issuer: Issuer | null;
  readonly issueCount: number;
  readonly issuedAt: string | null;
  readonly sentAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly createdAt: string;
  readonly documents: readonly DocView[];
  readonly recipients: readonly string[];
  readonly mails: readonly MailView[];
  readonly lines: readonly Line[];
  readonly adjustments: readonly Adjustment[];
  readonly appliedAdjustments: readonly Adjustment[];
}

export const INVOICE_STATUS_LABEL: Readonly<Record<InvoiceStatus, string>> = { FINALIZED: '未発行', ISSUED: '発行済み', SENT: '送付済み', VOIDED: '無効' };
const STATUS_PILL: Readonly<Record<InvoiceStatus, string>> = { FINALIZED: 'confirmed', ISSUED: 'approved', SENT: 'approved', VOIDED: 'revoked' };
const JOB_LABEL: Readonly<Record<string, string>> = {
  QUEUED: '作成待ち',
  PROCESSING: '作成中',
  GENERATED: '作成済み',
  SENDING: '送信中',
  SENT: '送信済み',
  FAILED_RETRYABLE: '再試行待ち',
  FAILED_FINAL: '失敗',
};
const ERROR_LABEL: Readonly<Record<string, string>> = {
  RECIPIENT_EMPTY: '送付先がありません（お客様担当者で「請求書メール」を有効にしてください）',
  RECIPIENT_INVALID: '送付先のメールアドレスが正しくありません',
  DOCUMENT_NOT_READY: 'PDF が作成されていません',
};
const ADJ_LABEL: Readonly<Record<Adjustment['status'], string>> = { PENDING: '未適用（次の請求に入ります）', APPLIED: '適用済み', CANCELLED: '取消' };
const LINE_LABEL: Readonly<Record<string, string>> = {
  WORK_QUANTITY: '作業（個数）',
  WORK_REGULAR: '通常作業',
  WORK_OVERTIME: '割増作業',
  TRANSPORT_PER_TRIP: '運搬（便ごと）',
  TRANSPORT_ALLOCATED: '運搬按分',
  TRANSPORT_MONTHLY: '運搬（月額）',
  FIXED_CHARGE: '固定費',
  ADJUSTMENT: '調整（訂正）',
};
const IN_FLIGHT = ['QUEUED', 'PROCESSING', 'SENDING', 'FAILED_RETRYABLE'];

const yen = (n: number): string => `${n < 0 ? '−' : ''}¥${Math.abs(n).toLocaleString('ja-JP')}`;
const when = (iso: string | null): string => {
  if (iso === null) return '—';
  const p = toJstParts(new Date(iso));
  return `${p.date} ${p.time}`;
};
const slash = (d: string | null): string => (d === null ? '—' : d.replaceAll('-', '/'));
const decimal = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

function ErrorBox({ error }: { error: ApiError | null }) {
  if (error === null) return null;
  return (
    <div className="ix-errorsummary" role="alert">
      <b>{error.message}</b>
      {error.fields !== undefined && error.fields.length > 1 ? (
        <ul>
          {error.fields.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function InvoiceScreen({ id }: { readonly id: string }) {
  const user = useAdminUser();
  const operable = user.roles.includes('OFFICE') || user.roles.includes('ADMIN');
  const { lookups } = useLookups();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendReason, setResendReason] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [adj, setAdj] = useState({ productId: '', sourceReportId: '', description: '', amount: '', reason: '' });
  const [cancelReason, setCancelReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await apiRequest<Invoice>('GET', `/invoices/${id}`);
    if (res.ok) {
      setInv(res.data);
      setLoadError(null);
    } else setLoadError(res.error.message);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // PDF 作成中・送信中は自動で再読込（3秒ごと、最大2分）
  const pending = inv !== null && (inv.documents.some((d) => IN_FLIGHT.includes(d.status)) || inv.mails.some((m) => IN_FLIGHT.includes(m.status)));
  useEffect(() => {
    if (!pending) return;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > 40) clearInterval(timer);
      void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const products = useMemo(
    () => [...lookups.products.values()].filter((p) => inv !== null && p.customerId === inv.customer.id).sort((a, b) => a.code.localeCompare(b.code)),
    [lookups, inv],
  );
  const reports = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of inv?.lines ?? []) if (l.reportId !== null && l.reportNo !== null && l.lineType !== 'ADJUSTMENT') map.set(l.reportId, l.reportNo);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [inv]);

  async function act(action: 'issue' | 'send' | 'resend' | 'void', body: Record<string, unknown>, done: string) {
    if (inv === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiRequest<Invoice>('POST', `/invoices/${id}/${action}`, { expectedVersion: inv.version, ...body }, { 'idempotency-key': newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      setInv(res.data);
      setResendReason('');
      setVoidReason('');
      setNotice(done);
    } else {
      setError(res.error);
      if (res.error.code === 'VERSION_CONFLICT') await load();
    }
  }

  async function createAdjustment() {
    if (inv === null) return;
    setError(null);
    setNotice(null);
    const amountYen = Number(adj.amount.replaceAll(',', '').replace('−', '-'));
    setBusy(true);
    const res = await apiRequest<Adjustment>(
      'POST',
      '/billing-adjustments',
      {
        sourceInvoiceId: inv.id,
        productId: adj.productId,
        sourceReportId: adj.sourceReportId === '' ? null : adj.sourceReportId,
        description: adj.description.trim(),
        amountYen: Number.isFinite(amountYen) ? amountYen : 0,
        reason: adj.reason.trim(),
      },
      { 'idempotency-key': newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok) {
      setAdj({ productId: '', sourceReportId: '', description: '', amount: '', reason: '' });
      setNotice('調整を登録しました。次の請求を計算すると明細に入ります。');
      await load();
    } else setError(res.error);
  }

  async function cancelAdjustment(a: Adjustment) {
    setError(null);
    setNotice(null);
    setBusy(true);
    const res = await apiRequest<Adjustment>('POST', `/billing-adjustments/${a.id}/cancel`, { expectedVersion: a.version, reason: (cancelReason[a.id] ?? '').trim() }, { 'idempotency-key': newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      setNotice('調整を取り消しました。');
      await load();
    } else setError(res.error);
  }

  if (loadError !== null) {
    return (
      <section className="ix-panel" role="alert">
        <h1>請求書</h1>
        <p>{loadError}</p>
        <a href="/admin/billing">請求の一覧へ戻る</a>
      </section>
    );
  }
  if (inv === null) return <p className="ix-muted" aria-live="polite">読み込み中…</p>;

  const docsBusy = inv.documents.some((d) => IN_FLIGHT.includes(d.status));
  const docsFailed = inv.documents.length > 0 && inv.documents.every((d) => d.status === 'FAILED_FINAL' || d.status === 'GENERATED') && inv.documents.some((d) => d.status === 'FAILED_FINAL');
  const mailBusy = inv.mails.some((m) => IN_FLIGHT.includes(m.status));
  const sendable = inv.status === 'ISSUED' || inv.status === 'SENT';
  const canIssue = operable && inv.status === 'FINALIZED' && !docsBusy && (inv.documents.length === 0 || docsFailed);
  const canSend = operable && sendable && !mailBusy && inv.mails.length === 0;
  const canResend = operable && sendable && !mailBusy && inv.mails.length > 0;
  const canVoid = operable && inv.status !== 'VOIDED' && !mailBusy;
  const activeAdjustments = inv.adjustments.filter((a) => a.status !== 'CANCELLED');

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small>
            <a href="/admin/billing">請求管理</a> / <a href={`/admin/billing/${inv.billingRunId}`}>請求計算・レビュー</a> / {inv.customer.code} {inv.customer.name}
          </small>
          <h1>
            請求書 {inv.invoiceNo} <span className={`ix-pill ${STATUS_PILL[inv.status]}`}>{INVOICE_STATUS_LABEL[inv.status]}</span>
          </h1>
          <p>
            {inv.periodLabel}（{slash(inv.periodStart)}〜{slash(inv.periodEnd)}）・{inv.customer.name} 御中
          </p>
        </div>
        {operable ? (
          <div className="ix-btnrow">
            {inv.status === 'FINALIZED' ? (
              <button type="button" className="ix-btn primary" disabled={busy || !canIssue} onClick={() => void act('issue', {}, '請求書PDFの作成を受け付けました。作成が終わると「発行済み」になります。')}>
                {docsFailed ? 'PDF をもう一度作成' : '請求書を発行（PDF 作成）'}
              </button>
            ) : null}
            {sendable && inv.mails.length === 0 ? (
              <button type="button" className="ix-btn primary" disabled={busy || !canSend} onClick={() => void act('send', {}, '送信を受け付けました。')}>
                お客様へ送付
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {notice !== null ? (
        <p className="ix-notice" role="status">
          {notice}
        </p>
      ) : null}
      <ErrorBox error={error} />

      {inv.status === 'VOIDED' ? (
        <div className="ix-decision revoke">
          <b>無効（{when(inv.voidedAt)}）</b>
          <p>{inv.voidReason}</p>
          <p className="ix-small">同じお客様・期間の請求を作り直すと、版が1つ上がった請求書番号になります。</p>
        </div>
      ) : null}

      <section className="ix-kpis ix-kpis4" aria-label="請求書の金額">
        <div>
          <span>小計（税抜）</span>
          <b>{yen(inv.subtotalYen)}</b>
          <small>明細 {inv.lines.length}件</small>
        </div>
        <div>
          <span>消費税 {Math.round(Number(inv.taxRate) * 100)}%</span>
          <b>{yen(inv.taxYen)}</b>
          <small>小計×税率（四捨五入）</small>
        </div>
        <div>
          <span>請求合計（税込）</span>
          <b>{yen(inv.totalYen)}</b>
          <small>版 {String(inv.revision).padStart(3, '0')}</small>
        </div>
        <div>
          <span>支払期限</span>
          <b style={{ fontSize: 17 }}>{slash(inv.dueDate)}</b>
          <small>{inv.issueDate !== null ? `発行日 ${slash(inv.issueDate)}` : '発行時に決まります（締め日の翌月末）'}</small>
        </div>
      </section>

      <section className="ix-panel" aria-labelledby="inv-docs">
        <h2 id="inv-docs">請求書PDF</h2>
        {inv.documents.length === 0 ? (
          <p className="ix-muted">まだ発行していません。「請求書を発行」で、請求書（鏡）と請求明細の PDF を作ります。</p>
        ) : (
          <ul className="ix-plainlist">
            {inv.documents.map((d) => (
              <li key={d.id}>
                <b>{d.kind === 'COVER' ? '請求書（鏡）' : '請求明細'}</b>：
                {d.url !== null ? (
                  <a href={d.url} target="_blank" rel="noopener noreferrer">
                    {d.fileName ?? 'PDF を開く'}
                  </a>
                ) : (
                  <span aria-live="polite">
                    {JOB_LABEL[d.status] ?? d.status}
                    {d.errorCode !== null ? `（${d.errorCode}）` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {inv.issuer !== null ? (
          <p className="ix-muted ix-small">
            発行元: {inv.issuer.name}
            {inv.issuer.address !== '' ? `・${inv.issuer.address}` : ''}・TEL {inv.issuer.tel}
            {inv.issuer.registrationNo !== '' ? `・登録番号 ${inv.issuer.registrationNo}` : '・登録番号 未設定'}
          </p>
        ) : null}
      </section>

      <section className="ix-panel" aria-labelledby="inv-mail">
        <h2 id="inv-mail">送付</h2>
        <p>
          送付先: {inv.recipients.length > 0 ? inv.recipients.join('、') : <b className="ix-red">ありません（お客様担当者マスタで「請求書メール」を有効にしてください）</b>}
        </p>
        {inv.mails.length > 0 ? (
          <div className="ix-datatable">
            <div className="ix-tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>回</th>
                    <th>状態</th>
                    <th>宛先</th>
                    <th>理由</th>
                    <th>日時</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.mails.map((m) => (
                    <tr key={m.id}>
                      <td>{m.sendRevision}</td>
                      <td>
                        {JOB_LABEL[m.status] ?? m.status}
                        {m.errorCode !== null ? (
                          <>
                            <br />
                            <small className="ix-red">{ERROR_LABEL[m.errorCode] ?? m.errorCode}</small>
                          </>
                        ) : null}
                      </td>
                      <td>{m.to.length > 0 ? m.to.join('、') : '—'}</td>
                      <td>{m.reason ?? '—'}</td>
                      <td>{when(m.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="ix-muted">{sendable ? 'まだ送付していません。' : '発行すると送付できます。'}</p>
        )}
        {canResend ? (
          <div className="ix-field" style={{ marginTop: 12 }}>
            <label htmlFor="inv-resend-reason">
              再送の理由<span className="ix-req">必須</span>
            </label>
            <input id="inv-resend-reason" maxLength={1000} value={resendReason} onChange={(e) => setResendReason(e.target.value)} placeholder="例: 先方で受信できていなかった" />
            <div className="ix-btnrow">
              <button type="button" className="ix-btn" disabled={busy || resendReason.trim() === ''} onClick={() => void act('resend', { reason: resendReason.trim() }, '再送を受け付けました。')}>
                再送する
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="ix-datatable" aria-label="請求明細">
        <h2>請求明細（請求書に載る明細）</h2>
        {inv.lines.length === 0 ? (
          <p className="ix-empty">明細はありません。</p>
        ) : (
          <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>No</th>
                  <th>日付</th>
                  <th>元実績</th>
                  <th>品番</th>
                  <th>区分</th>
                  <th className="num">数量/工数</th>
                  <th className="num">単価</th>
                  <th className="num">金額</th>
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.no} title={l.description}>
                    <td>{l.no}</td>
                    <td>{slash(l.businessDate)}</td>
                    <td>{l.reportNo ?? '—'}</td>
                    <td>{l.productCode}</td>
                    <td>{LINE_LABEL[l.lineType] ?? l.lineType}</td>
                    <td className="num">
                      {decimal(l.quantity)}
                      {l.unit}
                    </td>
                    <td className="num">{l.lineType === 'ADJUSTMENT' ? '—' : `¥${Number(l.unitPrice).toLocaleString('ja-JP', { maximumFractionDigits: 4 })}`}</td>
                    <td className="num">
                      <b>{yen(l.amountYen)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ix-panel" aria-labelledby="inv-adj">
        <h2 id="inv-adj">遅延訂正（調整）</h2>
        <p className="ix-muted ix-small">
          この請求書の後に誤りが見つかった場合、請求書は変えずに差額を「調整」として登録します。調整は次の請求（{inv.periodEnd.replaceAll('-', '/')} より後に締める請求）の明細に入ります。値引き・返金はマイナスで入力してください。
        </p>
        {inv.appliedAdjustments.length > 0 ? (
          <p>
            この請求書には、前の請求の調整が {inv.appliedAdjustments.length}件 入っています（
            {inv.appliedAdjustments.map((a) => `${a.sourceInvoiceNo} ${yen(a.amountYen)}`).join('、')}）。
          </p>
        ) : null}
        {inv.adjustments.length > 0 ? (
          <div className="ix-datatable">
            <div className="ix-tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>品番</th>
                    <th>元実績</th>
                    <th className="num">金額</th>
                    <th>状態</th>
                    <th>理由</th>
                    {operable ? <th>取消</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {inv.adjustments.map((a) => (
                    <tr key={a.id}>
                      <td>{a.description}</td>
                      <td>{a.productCode}</td>
                      <td>{a.sourceReportNo ?? '—'}</td>
                      <td className="num">{yen(a.amountYen)}</td>
                      <td>
                        {ADJ_LABEL[a.status]}
                        {a.status === 'APPLIED' && a.appliedInvoiceId !== null ? (
                          <>
                            {' '}
                            <a href={`/admin/invoices/${a.appliedInvoiceId}`}>適用先</a>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {a.reason}
                        {a.cancelReason !== null ? (
                          <>
                            <br />
                            <small className="ix-muted">取消: {a.cancelReason}</small>
                          </>
                        ) : null}
                      </td>
                      {operable ? (
                        <td>
                          {a.status === 'PENDING' ? (
                            <span className="ix-btnrow">
                              <input aria-label={`${a.description} の取消理由`} placeholder="取消の理由" maxLength={1000} value={cancelReason[a.id] ?? ''} onChange={(e) => setCancelReason({ ...cancelReason, [a.id]: e.target.value })} />
                              <button type="button" className="ix-btn" disabled={busy || (cancelReason[a.id] ?? '').trim() === ''} onClick={() => void cancelAdjustment(a)}>
                                取り消す
                              </button>
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {operable && inv.status !== 'VOIDED' ? (
          <form
            className="ix-form ix-inner"
            aria-label="調整の登録"
            onSubmit={(e) => {
              e.preventDefault();
              void createAdjustment();
            }}
          >
            <div className="ix-formgrid">
              <div className="ix-field">
                <label htmlFor="adj-product">
                  品番<span className="ix-req">必須</span>
                </label>
                <select id="adj-product" value={adj.productId} onChange={(e) => setAdj({ ...adj, productId: e.target.value })}>
                  <option value="">選択してください</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ix-field">
                <label htmlFor="adj-report">元実績（任意）</label>
                <select id="adj-report" value={adj.sourceReportId} onChange={(e) => setAdj({ ...adj, sourceReportId: e.target.value })}>
                  <option value="">指定しない</option>
                  {reports.map(([rid, no]) => (
                    <option key={rid} value={rid}>
                      {no}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ix-field">
                <label htmlFor="adj-desc">
                  内容<span className="ix-req">必須</span>
                </label>
                <input id="adj-desc" maxLength={200} value={adj.description} onChange={(e) => setAdj({ ...adj, description: e.target.value })} placeholder="例: 9/7 検査数の訂正" />
              </div>
              <div className="ix-field">
                <label htmlFor="adj-amount">
                  金額（円）<span className="ix-req">必須</span>
                </label>
                <input id="adj-amount" inputMode="numeric" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} placeholder="例: -500（値引き・返金はマイナス）" />
              </div>
              <div className="ix-field">
                <label htmlFor="adj-reason">
                  理由<span className="ix-req">必須</span>
                </label>
                <input id="adj-reason" maxLength={1000} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="例: 数量の入力誤り" />
              </div>
            </div>
            <div className="ix-actions">
              <span />
              <button type="submit" className="ix-btn" disabled={busy}>
                調整を登録
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {canVoid ? (
        <section className="ix-panel ix-form ix-inner" aria-labelledby="inv-void">
          <h2 id="inv-void">この請求書を無効にする</h2>
          <p className="ix-muted ix-small">
            請求書と請求を取り消し、対象の報告を承認済みに戻します（記録は残ります）。同じ期間の請求を作り直すと、版が1つ上がった番号の請求書になります。
            {inv.status === 'SENT' ? ' 送付済みのため、お客様へ差し替えの連絡をしてください。' : ''}
            {activeAdjustments.length > 0 ? ' この請求書を元にした調整があるため、先に調整を取り消してください。' : ''}
          </p>
          <div className="ix-field">
            <label htmlFor="inv-void-reason">
              無効にする理由<span className="ix-req">必須</span>
            </label>
            <input id="inv-void-reason" maxLength={1000} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </div>
          <div className="ix-actions">
            <span />
            <button type="button" className="ix-btn danger" disabled={busy || voidReason.trim() === '' || activeAdjustments.length > 0} onClick={() => void act('void', { reason: voidReason.trim() }, '請求書を無効にしました。')}>
              無効にする
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
