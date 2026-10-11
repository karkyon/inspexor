'use client';

/**
 * CHG-009 SCR-14 請求計算・レビュー（BILLING_ENABLED のときだけ。OFFICE/ADMIN が操作、AUDITOR は参照）。
 *  一覧: 請求 run（期間の新しい順）と、お客様＋年月から請求を作って計算する（API-034 / API-019 → API-021 calculate）
 *  詳細: 合計・警告（処置と理由 → review）・明細・計算版の切替、再計算・確定・取消（API-020 / API-021）
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { closingDateForMonth, toJstParts } from '@inspexor/domain';
import { apiRequest, type ApiError } from '../../lib/api/client';
import { newIdempotencyKey } from '../field/FieldParts';
import { useAdminUser } from './AdminShell';

type RunStatus = 'OPEN' | 'CALCULATING' | 'CALCULATED' | 'NEEDS_REVIEW' | 'REVIEWED' | 'FINALIZED' | 'ISSUED' | 'SENT' | 'VOIDED';

export interface BillingRun {
  readonly id: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly closingDay: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly calcVersion: number;
  readonly subtotalYen: number;
  readonly taxYen: number;
  readonly totalYen: number;
  readonly taxRate: string;
  readonly lineCount: number;
  readonly warningCount: number;
  readonly openWarningCount: number;
  readonly sourceCount: number;
  readonly unapprovedCount: number;
  readonly excludedReportIds: readonly string[];
  readonly runHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly calculatedAt: string | null;
  readonly reviewedAt: string | null;
  readonly reviewReason: string | null;
  readonly finalizedAt: string | null;
  readonly invoiceId: string | null;
  readonly invoiceNo: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
}

interface Line {
  readonly no: number;
  readonly lineType: string;
  readonly sourceType: 'WORK' | 'DELIVERY' | 'RULE';
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

interface Warning {
  readonly id: string;
  readonly code: string;
  readonly sourceType: 'WORK' | 'DELIVERY' | 'RULE';
  readonly reportId: string | null;
  readonly reportNo: string | null;
  readonly businessDate: string | null;
  readonly productCode: string | null;
  readonly message: string;
  readonly disposition: { resolution: 'ACCEPT' | 'EXCLUDE'; reason: string; at: string } | null;
}

interface Detail extends BillingRun {
  readonly viewingCalcVersion: number;
  readonly lines: readonly Line[];
  readonly warnings: readonly Warning[];
  readonly calcs: ReadonlyArray<{ calcVersion: number; calculatedAt: string; totalYen: number; warningCount: number }>;
}

export const BILLING_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  OPEN: '未計算',
  CALCULATING: '計算中',
  CALCULATED: '計算済み',
  NEEDS_REVIEW: '要確認',
  REVIEWED: '確認済み',
  FINALIZED: '確定済み',
  ISSUED: '発行済み',
  SENT: '送付済み',
  VOIDED: '取消',
};
const STATUS_PILL: Readonly<Record<RunStatus, string>> = {
  OPEN: 'draft',
  CALCULATING: 'draft',
  CALCULATED: 'confirmed',
  NEEDS_REVIEW: 'rejected',
  REVIEWED: 'confirmed',
  FINALIZED: 'approved',
  ISSUED: 'approved',
  SENT: 'approved',
  VOIDED: 'revoked',
};
const LINE_LABEL: Readonly<Record<string, string>> = {
  WORK_QUANTITY: '作業（個数）',
  WORK_REGULAR: '通常作業',
  WORK_OVERTIME: '割増作業',
  TRANSPORT_PER_TRIP: '運搬（便ごと）',
  TRANSPORT_ALLOCATED: '運搬按分',
  TRANSPORT_MONTHLY: '運搬（月額）',
  FIXED_CHARGE: '固定費',
};
const WARNING_LABEL: Readonly<Record<string, string>> = {
  RULE_NOT_FOUND: 'ルールがありません',
  RULE_AMBIGUOUS: 'ルールが複数該当します',
  NO_ALLOCATION_TARGET: '按分対象の品番がありません',
  NEGATIVE_INVOICE: '請求合計が負です',
};
const RECALC: readonly RunStatus[] = ['OPEN', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED'];
const FINALIZABLE: readonly RunStatus[] = ['CALCULATED', 'REVIEWED'];

const yen = (n: number): string => `¥${n.toLocaleString('ja-JP')}`;
const when = (iso: string | null): string => {
  if (iso === null) return '—';
  const p = toJstParts(new Date(iso));
  return `${p.date} ${p.time}`;
};
const md = (date: string | null): string => (date === null ? '期間' : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`);
const decimal = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const period = (r: { periodStart: string; periodEnd: string }): string => `${r.periodStart.replaceAll('-', '/')}–${r.periodEnd.replaceAll('-', '/')}`;

function previousMonth(): string {
  const p = toJstParts(new Date());
  const [y, m] = p.date.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function canOperate(roles: readonly string[]): boolean {
  return roles.includes('OFFICE') || roles.includes('ADMIN');
}

function reportHref(w: { sourceType: string; reportId: string | null }): string | null {
  if (w.reportId === null) return null;
  return `/admin/records/${w.sourceType === 'DELIVERY' ? 'delivery' : 'work'}/${w.reportId}`;
}

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

// ======================================================================== 一覧

export function BillingListScreen() {
  const user = useAdminUser();
  const operable = canOperate(user.roles);
  const [runs, setRuns] = useState<BillingRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Array<{ id: string; code: string; name: string; closingDay: number; active: boolean }>>([]);
  const [customerId, setCustomerId] = useState('');
  const [month, setMonth] = useState(previousMonth());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void apiRequest<BillingRun[]>('GET', '/billing-runs').then((res) => (res.ok ? setRuns(res.data) : setLoadError(res.error.message)));
    void (async () => {
      // お客様は件数が多くても全件（100件ずつ）
      const all: Array<{ id: string; code: string; name: string; closingDay: number; active: boolean }> = [];
      for (let page = 1; page <= 50; page += 1) {
        const res = await apiRequest<typeof all>('GET', `/masters/customers?page=${page}&pageSize=100`);
        if (!res.ok) break;
        all.push(...res.data);
        if (all.length >= (res.meta?.total ?? 0) || res.data.length === 0) break;
      }
      setCustomers(all.filter((c) => c.active));
    })();
  }, []);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const periodEnd = customer !== null && /^\d{4}-\d{2}$/.test(month) ? closingDateForMonth(month, customer.closingDay) : null;

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const fields = [
      ...(customerId === '' ? [{ path: '/customerId', code: 'required', message: 'お客様を選んでください。' }] : []),
      ...(periodEnd === null ? [{ path: '/periodEnd', code: 'required', message: '請求月を選んでください。' }] : []),
    ];
    if (fields.length > 0) {
      setError({ code: 'VALIDATION_ERROR', message: '入力内容を確認してください', fields });
      return;
    }
    setBusy(true);
    const created = await apiRequest<BillingRun>('POST', '/billing-runs', { customerId, periodEnd }, { 'idempotency-key': newIdempotencyKey() });
    if (!created.ok) {
      const existing = (created.error as ApiError & { existingRunId?: string }).existingRunId;
      if (existing !== undefined) {
        window.location.href = `/admin/billing/${existing}?notice=exists`;
        return;
      }
      setBusy(false);
      setError(created.error);
      return;
    }
    await apiRequest('POST', `/billing-runs/${created.data.id}/calculate`, { expectedVersion: created.data.version }, { 'idempotency-key': newIdempotencyKey() });
    window.location.href = `/admin/billing/${created.data.id}`;
  }

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">請求管理</small>
          <h1>請求</h1>
          <p>承認済みの作業日報・運搬実績から、お客様ごと・締め日ごとの請求を計算します。確定すると請求書になり、対象の報告は変更できなくなります。</p>
        </div>
      </header>
      {operable ? (
        <form className="ix-panel ix-form" onSubmit={(e) => void start(e)} aria-labelledby="bill-new">
          <h2 id="bill-new">請求を計算する</h2>
          <ErrorBox error={error} />
          <div className="ix-formgrid">
            <div className="ix-field">
              <label htmlFor="bill-customer">
                お客様<span className="ix-req">必須</span>
              </label>
              <select id="bill-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-invalid={error?.fields?.some((f) => f.path === '/customerId') || undefined}>
                <option value="">選択してください</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}（{c.closingDay === 31 ? '月末' : `${c.closingDay}日`}締め）
                  </option>
                ))}
              </select>
            </div>
            <div className="ix-field">
              <label htmlFor="bill-month">
                請求月<span className="ix-req">必須</span>
              </label>
              <input id="bill-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              <small className="ix-muted">{periodEnd !== null ? `締め日 ${periodEnd.replaceAll('-', '/')} までの承認済みの報告が対象です。` : 'お客様を選ぶと締め日を表示します。'}</small>
            </div>
          </div>
          <div className="ix-actions">
            <span />
            <button type="submit" className="ix-btn primary" disabled={busy}>
              {busy ? '計算しています…' : '請求を計算する'}
            </button>
          </div>
        </form>
      ) : null}
      <section className="ix-datatable" aria-label="請求の一覧">
        {loadError !== null ? (
          <p role="alert">{loadError}</p>
        ) : runs === null ? (
          <p aria-busy="true">読み込み中…</p>
        ) : runs.length === 0 ? (
          <p className="ix-empty">まだ請求はありません。{operable ? '上のフォームから計算してください。' : ''}</p>
        ) : (
          <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>請求期間</th>
                  <th>お客様</th>
                  <th>状態</th>
                  <th className="num">請求合計</th>
                  <th className="num">要確認</th>
                  <th>請求書</th>
                  <th>更新日時</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/admin/billing/${r.id}`}>
                        <b>{period(r)}</b>
                      </a>
                    </td>
                    <td>
                      {r.customerCode} {r.customerName}
                    </td>
                    <td>
                      <span className={`ix-pill ${STATUS_PILL[r.status]}`}>{BILLING_STATUS_LABEL[r.status]}</span>
                    </td>
                    <td className="num">{r.calcVersion === 0 ? '—' : yen(r.totalYen)}</td>
                    <td className="num">{r.openWarningCount > 0 ? <b className="ix-red">{r.openWarningCount}件</b> : '—'}</td>
                    <td>{r.invoiceNo ?? '—'}</td>
                    <td>{when(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ======================================================================== 詳細

export function BillingRunScreen({ id, notice: initialNotice }: { readonly id: string; readonly notice?: string | undefined }) {
  const user = useAdminUser();
  const operable = canOperate(user.roles);
  const [d, setD] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [resolutions, setResolutions] = useState<Record<string, 'ACCEPT' | 'EXCLUDE' | ''>>({});
  const [reviewReason, setReviewReason] = useState('');
  const [voidReason, setVoidReason] = useState('');

  const load = useCallback(async (calcVersion: number | null = null) => {
    const res = await apiRequest<Detail>('GET', `/billing-runs/${id}${calcVersion !== null ? `?calcVersion=${calcVersion}` : ''}`);
    if (res.ok) {
      setD(res.data);
      setLoadError(null);
    } else setLoadError(res.error.message);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = d !== null && d.viewingCalcVersion === d.calcVersion;
  const excluded = useMemo(() => new Set(d?.excludedReportIds ?? []), [d]);

  async function act(action: 'calculate' | 'review' | 'finalize' | 'void', body: Record<string, unknown>, done: string) {
    if (d === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiRequest<Detail>('POST', `/billing-runs/${id}/${action}`, { expectedVersion: d.version, ...body }, { 'idempotency-key': newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      setD(res.data);
      setViewing(null);
      setResolutions({});
      setReviewReason('');
      setVoidReason('');
      setNotice(done);
    } else {
      setError(res.error);
      if (res.error.code === 'VERSION_CONFLICT') await load();
    }
  }

  if (loadError !== null) {
    return (
      <section className="ix-panel" role="alert">
        <h1>請求</h1>
        <p>{loadError}</p>
        <a href="/admin/billing">請求の一覧へ戻る</a>
      </section>
    );
  }
  if (d === null) return <p className="ix-muted" aria-live="polite">読み込み中…</p>;

  const reviewable = operable && latest && d.status === 'NEEDS_REVIEW';
  const allChosen = d.warnings.every((w) => (resolutions[w.id] ?? '') !== '');

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small>
            <a href="/admin/billing">請求管理</a> / {d.customerCode} {d.customerName}
          </small>
          <h1>
            請求計算・レビュー <span className={`ix-pill ${STATUS_PILL[d.status]}`}>{BILLING_STATUS_LABEL[d.status]}</span>
          </h1>
          <p>
            対象期間 {period(d)}・計算版 {d.calcVersion === 0 ? '—' : d.calcVersion}
            {d.calculatedAt !== null ? `（${when(d.calculatedAt)} 計算）` : ''}
          </p>
        </div>
        {operable ? (
          <div className="ix-btnrow">
            {RECALC.includes(d.status) ? (
              <button type="button" className="ix-btn" disabled={busy} onClick={() => void act('calculate', {}, '計算しました。')}>
                {d.calcVersion === 0 ? '計算する' : '再計算'}
              </button>
            ) : null}
            {FINALIZABLE.includes(d.status) ? (
              <button type="button" className="ix-btn primary" disabled={busy || !latest} onClick={() => void act('finalize', {}, '請求を確定しました。')}>
                請求を確定
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {notice !== null ? (
        <p className="ix-notice" role="status">
          {notice === 'exists' ? 'このお客様・期間の請求は既にあります。' : notice}
        </p>
      ) : null}
      <ErrorBox error={error} />

      {d.status === 'FINALIZED' || d.status === 'ISSUED' || d.status === 'SENT' ? (
        <div className="ix-decision approve">
          <b>確定済み（{when(d.finalizedAt)}）</b>
          <p>
            請求書 {d.invoiceNo ?? '—'}。対象の報告は「請求確定済」になり、修正・取消できません。
          </p>
        </div>
      ) : null}
      {d.status === 'VOIDED' ? (
        <div className="ix-decision revoke">
          <b>取消（{when(d.voidedAt)}）</b>
          <p>{d.voidReason}</p>
        </div>
      ) : null}
      {d.unapprovedCount > 0 && !['FINALIZED', 'ISSUED', 'SENT', 'VOIDED'].includes(d.status) ? (
        <p className="ix-notice">
          期間内に承認されていない報告が {d.unapprovedCount}件 あります（請求に含まれません）。<a href="/admin/records">報告一覧で確認</a>
        </p>
      ) : null}

      <section className="ix-kpis ix-kpis4" aria-label="請求の合計">
        <div>
          <span>お客様</span>
          <b style={{ fontSize: 17 }}>{d.customerName}</b>
          <small>{d.closingDay === 31 ? '月末' : `${d.closingDay}日`}締め・対象 {d.sourceCount}件</small>
        </div>
        <div>
          <span>請求小計</span>
          <b>{yen(d.subtotalYen)}</b>
          <small>明細 {d.lineCount}件{excluded.size > 0 ? `・除外 ${excluded.size}件` : ''}</small>
        </div>
        <div>
          <span>消費税 {Math.round(Number(d.taxRate) * 100)}%</span>
          <b>{yen(d.taxYen)}</b>
          <small>小計×税率（四捨五入）</small>
        </div>
        <div>
          <span>請求合計</span>
          <b>{yen(d.totalYen)}</b>
          <small>{d.runHash !== null ? `hash ${d.runHash.slice(0, 12)}` : '未計算'}</small>
        </div>
      </section>

      {d.calcs.length > 1 ? (
        <div className="ix-searchbar">
          <label htmlFor="bill-calc">計算版</label>
          <select
            id="bill-calc"
            value={viewing ?? d.viewingCalcVersion}
            onChange={(e) => {
              const v = Number(e.target.value);
              setViewing(v);
              void load(v === d.calcVersion ? null : v);
            }}
          >
            {[...d.calcs].reverse().map((c) => (
              <option key={c.calcVersion} value={c.calcVersion}>
                版{c.calcVersion}（{when(c.calculatedAt)}・{yen(c.totalYen)}・警告{c.warningCount}件）{c.calcVersion === d.calcVersion ? ' 現在' : ''}
              </option>
            ))}
          </select>
          {!latest ? <small className="ix-muted">過去の計算版を表示しています（参照のみ）。</small> : null}
        </div>
      ) : null}

      {d.warnings.length > 0 ? (
        <section className="ix-panel ix-approval" aria-labelledby="bill-warn">
          <h2 id="bill-warn">
            {d.warnings.every((w) => w.disposition !== null) ? `警告 ${d.warnings.length}件（処置済み）` : `⚠ 要確認 ${d.warnings.length}件`}{' '}
            <small className="ix-muted">{d.status === 'NEEDS_REVIEW' && latest ? 'すべてに処置を選ぶまで確定できません。ルールを直した場合は再計算してください。' : ''}</small>
          </h2>
          <div className="ix-datatable">
            <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>内容</th>
                  <th>報告</th>
                  <th>処置</th>
                </tr>
              </thead>
              <tbody>
                {d.warnings.map((w) => {
                  const href = reportHref(w);
                  return (
                    <tr key={w.id}>
                      <td>
                        <b>{WARNING_LABEL[w.code] ?? w.code}</b>
                        <br />
                        <small>{w.message}</small>
                      </td>
                      <td>{href !== null ? <a href={href}>{w.reportNo}</a> : '—'}</td>
                      <td>
                        {reviewable ? (
                          <select
                            aria-label={`${w.reportNo ?? w.productCode ?? ''} ${WARNING_LABEL[w.code] ?? w.code} の処置`}
                            value={resolutions[w.id] ?? ''}
                            onChange={(e) => setResolutions({ ...resolutions, [w.id]: e.target.value as 'ACCEPT' | 'EXCLUDE' | '' })}
                          >
                            <option value="">選択してください</option>
                            <option value="ACCEPT">このまま請求する（この明細は 0 円）</option>
                            <option value="EXCLUDE" disabled={w.reportId === null}>
                              この報告を請求から除外する
                            </option>
                          </select>
                        ) : w.disposition !== null ? (
                          <span>
                            {w.disposition.resolution === 'EXCLUDE' ? '除外' : 'このまま請求'}
                            <br />
                            <small className="ix-muted">{w.disposition.reason}</small>
                          </span>
                        ) : (
                          <span className="ix-muted">未処置</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
          {reviewable ? (
            <div className="ix-field" style={{ marginTop: 12 }}>
              <label htmlFor="bill-review-reason">
                レビューの理由<span className="ix-req">必須</span>
              </label>
              <textarea id="bill-review-reason" maxLength={1000} value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} placeholder="例: 単価未設定の品番は来月まとめて請求する" />
              <div className="ix-btnrow">
                <button
                  type="button"
                  className="ix-btn primary"
                  disabled={busy || !allChosen || reviewReason.trim() === ''}
                  onClick={() => void act('review', { reason: reviewReason.trim(), resolutions: d.warnings.map((w) => ({ warningId: w.id, resolution: resolutions[w.id] })) }, 'レビューを完了しました。確定できます。')}
                >
                  レビューを完了
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="ix-datatable" aria-label="請求明細">
        {d.lines.length === 0 ? (
          <p className="ix-empty">{d.calcVersion === 0 ? 'まだ計算していません。' : '請求する明細はありません（承認済みの報告・期間のルールがありません）。'}</p>
        ) : (
          <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>元実績</th>
                  <th>品番</th>
                  <th>区分</th>
                  <th className="num">数量/工数</th>
                  <th className="num">単価</th>
                  <th className="num">倍率</th>
                  <th className="num">金額</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => {
                  const out = l.reportId !== null && excluded.has(l.reportId) && latest;
                  const href = reportHref(l);
                  return (
                    <tr key={l.no} className={out ? 'ix-muted' : undefined} title={l.description}>
                      <td>{md(l.businessDate)}</td>
                      <td>{href !== null ? <a href={href}>{l.reportNo}</a> : '—'}</td>
                      <td>{l.productCode}</td>
                      <td>
                        {LINE_LABEL[l.lineType] ?? l.lineType}
                        {out ? '（除外）' : ''}
                      </td>
                      <td className="num">
                        {decimal(l.quantity)}
                        {l.unit}
                      </td>
                      <td className="num">¥{Number(l.unitPrice).toLocaleString('ja-JP', { maximumFractionDigits: 4 })}</td>
                      <td className="num">{l.multiplier === null ? '—' : Number(l.multiplier).toFixed(2)}</td>
                      <td className="num">
                        <b>{out ? <s>{yen(l.amountYen)}</s> : yen(l.amountYen)}</b>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {operable && ['OPEN', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED'].includes(d.status) ? (
        <section className="ix-panel ix-form ix-inner" aria-labelledby="bill-void">
          <h2 id="bill-void">この請求を取り消す</h2>
          <p className="ix-muted ix-small">確定前の請求を取り消します。取り消すと、同じお客様・期間で作り直せます（記録は残ります）。</p>
          <div className="ix-field">
            <label htmlFor="bill-void-reason">
              取消の理由<span className="ix-req">必須</span>
            </label>
            <input id="bill-void-reason" maxLength={1000} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </div>
          <div className="ix-actions">
            <span />
            <button type="button" className="ix-btn danger" disabled={busy || voidReason.trim() === ''} onClick={() => void act('void', { reason: voidReason.trim() }, '請求を取り消しました。')}>
              取り消す
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
