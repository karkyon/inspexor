'use client';

/**
 * SCR-19 在庫（CHG-018、SK-2026-08-MINI-09 6章・モック「在庫あり」）。事務所・管理者が登録、監査は参照のみ。
 * 品番ごとの残高（預かり在庫・調整用在庫・検査ロット・問題点）→ 取引の履歴 → 登録（納入・1箱回す・棚卸・利用開始時の残高。保存前に見込みを確認）→ 在庫集計表（画面・Excel）。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api/client';
import { newIdempotencyKey } from '../field/FieldParts';
import { useAdminUser } from './AdminShell';
import { currentMonthRangeJst } from '../../lib/records/labels';

interface Lot {
  lotKey: string;
  lotDate: string;
  lotLabel: string;
  quantity: number;
}
interface Issue {
  kind: 'LOT_NEGATIVE' | 'ADJ_NEGATIVE';
  businessDate: string;
  lotKey: string | null;
  quantity: number;
  movementId: string | null;
}
interface Balance {
  productId: string;
  code: string;
  name: string;
  unitsPerBox: number | null;
  adjustStockManaged: boolean;
  adjustLowThreshold: number;
  deposit: number;
  adjust: number;
  lots: Lot[];
  issues: Issue[];
  adjustLow: boolean;
  hasOpening: boolean;
  openingDate: string | null;
  movementCount: number;
}
interface Movement {
  id: string;
  movementNo: string;
  businessDate: string;
  type: string;
  fromBucket: string;
  toBucket: string;
  lotLabel: string | null;
  quantity: number;
  sourceKind: string;
  reason: string | null;
  reversed: boolean;
  reversalOf: string | null;
}
interface MonthRowView {
  date: string;
  inMonth: boolean;
  lotNo: string;
  prevAdjust: number | null;
  takeBack: number | null;
  selected: number | null;
  ngTotal: number;
  delivered: number | null;
  endAdjust: number | null;
  replenish: number;
  boxDifference: number;
  stocktake: number;
  hours: number | null;
  perHour: number | null;
}
interface MonthView {
  rows: MonthRowView[];
  totals: { openAdjust: number; closeAdjust: number; closeDeposit: number; takeBack: number; selected: number; ngTotal: number; delivered: number };
}

const TYPE_LABEL: Record<string, string> = {
  INSPECT: '検品', NG: '不良', FILL: '補充（調整用→ロット）', SURPLUS: '余り（ロット→調整用）', REPLENISH: '1箱回す', DELIVERY: '納入', STOCKTAKE: '棚卸', OPENING: '利用開始時の残高', REVERSAL: '取消し',
};
const ACTIONS = [
  { key: 'delivery', label: '納入' },
  { key: 'replenish', label: '1箱回す' },
  { key: 'stocktake', label: '棚卸' },
  { key: 'opening', label: '開始時の残高' },
] as const;
type Action = (typeof ACTIONS)[number]['key'];
const TABS = [
  { key: 'balance', label: '残高・ロット' },
  { key: 'movements', label: '取引の履歴' },
  { key: 'register', label: '登録' },
  { key: 'monthly', label: '在庫集計表' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const n = (v: number | null): string => (v === null ? '' : v.toLocaleString('ja-JP'));
const ISSUE_LABEL: Record<string, string> = { LOT_NEGATIVE: '預かり在庫（ロット）がマイナス', ADJ_NEGATIVE: '調整用在庫がマイナス' };
const intOrUndef = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

export function InventoryScreen() {
  const user = useAdminUser();
  const canWrite = user.roles.some((r) => r === 'OFFICE' || r === 'ADMIN');
  const [list, setList] = useState<Balance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [tab, setTab] = useState<Tab>('balance');

  const reload = useCallback(async (): Promise<void> => {
    const r = await apiRequest<Balance[]>('GET', '/inventory');
    if (!r.ok) {
      setError(r.status === 404 ? '在庫管理は有効になっていません。' : '在庫を読み込めませんでした。');
      return;
    }
    setError(null);
    setList(r.data);
    setSelected((cur) => (cur !== '' && r.data.some((b) => b.productId === cur) ? cur : (r.data[0]?.productId ?? '')));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const current = useMemo(() => list?.find((b) => b.productId === selected) ?? null, [list, selected]);

  if (error !== null) return <p className="ix-error" role="alert">{error}</p>;
  if (list === null) return <p className="ix-muted" aria-busy="true">読み込み中…</p>;
  if (list.length === 0) return <p className="ix-empty">在庫を管理する品番がありません。マスター管理の品番で「在庫を管理する」を有効にしてください。</p>;

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <h1>在庫</h1>
      </header>
      <section className="ix-datatable" aria-label="品番ごとの残高">
        <div className="ix-tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">品番</th>
                <th scope="col">品名</th>
                <th scope="col" className="num">預かり在庫</th>
                <th scope="col" className="num">調整用在庫</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.productId} aria-selected={b.productId === selected}>
                  <td>
                    <button type="button" className="ix-btn" onClick={() => setSelected(b.productId)} aria-pressed={b.productId === selected}>
                      {b.code}
                    </button>
                  </td>
                  <td>{b.name}</td>
                  <td className="num">{n(b.deposit)}</td>
                  <td className="num">{b.adjustStockManaged ? n(b.adjust) : '—'}</td>
                  <td>
                    {!b.hasOpening ? <span className="ix-pill">開始時の残高が未登録</span> : null}
                    {b.issues.length > 0 ? <span className="ix-pill ix-red">問題点 {b.issues.length}件</span> : null}
                    {b.adjustLow && b.issues.length === 0 ? <span className="ix-pill ix-amber">調整用が少ない</span> : null}
                    {b.hasOpening && b.issues.length === 0 && !b.adjustLow ? '正常' : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {current !== null ? (
        <section className="ix-panel" aria-label={`${current.code} の在庫`}>
          <div className="ix-tabbar">
            <div role="tablist" aria-label="在庫の表示">
              {TABS.filter((t) => t.key !== 'register' || canWrite).map((t) => (
                <button key={t.key} type="button" role="tab" id={`inv-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="inv-panel" className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div role="tabpanel" id="inv-panel" aria-labelledby={`inv-tab-${tab}`}>
            {tab === 'balance' ? <BalanceTab b={current} /> : tab === 'movements' ? <MovementsTab b={current} canWrite={canWrite} onChanged={reload} /> : tab === 'register' ? <RegisterTab b={current} onChanged={reload} /> : <MonthlyTab b={current} />}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function BalanceTab({ b }: { b: Balance }) {
  return (
    <div>
      <p>
        {b.code} {b.name}。1箱 {b.unitsPerBox === null ? '—' : `${n(b.unitsPerBox)}個`}。
        {b.openingDate !== null ? `利用開始 ${b.openingDate}。` : ''}
      </p>
      {b.issues.length > 0 ? (
        <div className="ix-notice" role="alert">
          <b>問題点があります</b>
          <ul>
            {b.issues.map((i, k) => (
              <li key={k}>
                {i.businessDate} {ISSUE_LABEL[i.kind] ?? i.kind}（{n(i.quantity)}個）
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h2>預かり在庫（検査ロットごと・古い順）</h2>
      {b.lots.length === 0 ? (
        <p className="ix-empty">預かり在庫はありません。</p>
      ) : (
        <div className="ix-tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">検査日</th>
                <th scope="col">ロット</th>
                <th scope="col" className="num">残数</th>
              </tr>
            </thead>
            <tbody>
              {b.lots.map((l) => (
                <tr key={l.lotKey}>
                  <td>{l.lotDate}</td>
                  <td>{l.lotLabel}</td>
                  <td className="num">{n(l.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {b.adjustStockManaged ? (
        <p>
          調整用在庫: <b>{n(b.adjust)}</b>個{b.adjustLow ? '（少なくなっています。1箱回してください）' : ''}
        </p>
      ) : null}
    </div>
  );
}

function MovementsTab({ b, canWrite, onChanged }: { b: Balance; canWrite: boolean; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const r = await apiRequest<Movement[]>('GET', `/inventory/${b.productId}/movements?includeReversed=true`);
    setRows(r.ok ? r.data : []);
  }, [b.productId]);
  useEffect(() => {
    void load();
  }, [load, b.movementCount]);

  async function reverse(m: Movement): Promise<void> {
    const reason = window.prompt(`${m.movementNo} を取り消します。理由を入力してください。`);
    if (reason === null || reason.trim() === '') return;
    const r = await apiRequest('POST', `/inventory/${b.productId}/movements/${m.id}/reverse`, { reason: reason.trim() }, { 'Idempotency-Key': newIdempotencyKey() });
    setMsg(r.ok ? `${m.movementNo} を取り消しました。` : r.error.message);
    await Promise.all([load(), onChanged()]);
  }

  if (rows === null) return <p className="ix-muted" aria-busy="true">読み込み中…</p>;
  return (
    <div>
      {msg !== null ? <p role="status" className="ix-notice">{msg}</p> : null}
      <div className="ix-tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">番号</th>
              <th scope="col">業務日</th>
              <th scope="col">種別</th>
              <th scope="col">ロット</th>
              <th scope="col" className="num">数量</th>
              <th scope="col">理由</th>
              <th scope="col">登録元</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={m.reversed ? 'ix-muted' : ''}>
                <td>{m.movementNo}</td>
                <td>{m.businessDate}</td>
                <td>
                  {TYPE_LABEL[m.type] ?? m.type}
                  {m.reversed ? '（取消し済み）' : ''}
                </td>
                <td>{m.lotLabel ?? ''}</td>
                <td className="num">{n(m.quantity)}</td>
                <td>{m.reason ?? ''}</td>
                <td>{m.sourceKind === 'REPORT' ? '日報' : '画面'}</td>
                <td>
                  {canWrite && m.sourceKind === 'SCREEN' && !m.reversed && m.type !== 'REVERSAL' ? (
                    <button type="button" className="ix-btn" onClick={() => void reverse(m)}>
                      取り消す
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="ix-empty">取引はありません。</p> : null}
    </div>
  );
}

interface PreviewResult {
  allocations: Array<{ lotKey: string; lotDate: string; quantity: number }>;
  issues: Issue[];
  depositDelta: number;
  adjustDelta: number;
}

function RegisterTab({ b, onChanged }: { b: Balance; onChanged: () => Promise<void> }) {
  const [action, setAction] = useState<Action>(b.hasOpening ? 'delivery' : 'opening');
  const [date, setDate] = useState('');
  const [quantity, setQuantity] = useState('');
  const [lotKey, setLotKey] = useState('');
  const [boxes, setBoxes] = useState('');
  const [countedDeposit, setCountedDeposit] = useState('');
  const [countedAdjust, setCountedAdjust] = useState('');
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState('');
  const [openLots, setOpenLots] = useState<Array<{ lotDate: string; quantity: string }>>([{ lotDate: '', quantity: '' }]);
  const [ack, setAck] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function body(extra: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = { businessDate: date, ...extra };
    if (action === 'delivery') base['quantity'] = intOrUndef(quantity);
    if (action === 'replenish') {
      base['lotKey'] = lotKey;
      base['boxes'] = intOrUndef(boxes);
    }
    if (action === 'stocktake') {
      base['countedDeposit'] = intOrUndef(countedDeposit);
      if (b.adjustStockManaged) base['countedAdjust'] = intOrUndef(countedAdjust);
      base['reason'] = reason;
    }
    if (action === 'opening') {
      base['adjust'] = b.adjustStockManaged ? (intOrUndef(adjust) ?? 0) : 0;
      base['lots'] = openLots.filter((l) => l.lotDate !== '' && intOrUndef(l.quantity) !== undefined && Number(l.quantity) > 0).map((l) => ({ lotDate: l.lotDate, quantity: Number(l.quantity) }));
    }
    if (ack) base['acknowledgeAdjustShort'] = true;
    return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined));
  }

  async function submit(e: FormEvent, doPreview: boolean): Promise<void> {
    e.preventDefault();
    setMsg(null);
    if (doPreview) {
      const r = await apiRequest<PreviewResult>('POST', `/inventory/${b.productId}/${action}?preview=true`, body({ preview: true }), { 'Idempotency-Key': newIdempotencyKey() });
      if (r.ok) setPreview(r.data);
      else setMsg({ ok: false, text: r.error.message });
      return;
    }
    const r = await apiRequest('POST', `/inventory/${b.productId}/${action}`, body({}), { 'Idempotency-Key': newIdempotencyKey() });
    if (r.ok) {
      setPreview(null);
      setAck(false);
      setMsg({ ok: true, text: '登録しました。' });
      await onChanged();
    } else setMsg({ ok: false, text: r.error.message });
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, opts: { type?: string; required?: boolean } = {}) => (
    <div className="ix-field">
      <label htmlFor={id}>
        {label}
        {opts.required === false ? null : <span className="ix-req">必須</span>}
      </label>
      <input id={id} type={opts.type ?? 'number'} inputMode={opts.type === 'date' || opts.type === 'text' ? undefined : 'numeric'} min={opts.type === undefined || opts.type === 'number' ? 0 : undefined} value={value} onChange={(e) => { set(e.target.value); setPreview(null); }} />
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e, false)} className="ix-form" noValidate>
      <div role="radiogroup" aria-label="登録の種類" className="ix-btnrow">
        {ACTIONS.map((a) => (
          <label key={a.key} className={`ix-btn${action === a.key ? ' primary' : ''}`}>
            <input type="radio" name="inv-action" value={a.key} checked={action === a.key} onChange={() => { setAction(a.key); setPreview(null); setMsg(null); }} className="ix-sr" />
            {a.label}
          </label>
        ))}
      </div>
      <div className="ix-formgrid">
        {field('inv-date', action === 'delivery' ? '納入日' : '取引日', date, setDate, { type: 'date' })}
        {action === 'delivery' ? field('inv-qty', '納入数（個）', quantity, setQuantity) : null}
        {action === 'replenish' ? (
          <>
            <div className="ix-field">
              <label htmlFor="inv-lot">
                回すロット<span className="ix-req">必須</span>
              </label>
              <select id="inv-lot" value={lotKey} onChange={(e) => { setLotKey(e.target.value); setPreview(null); }}>
                <option value="">選択してください</option>
                {b.lots.map((l) => (
                  <option key={l.lotKey} value={l.lotKey}>
                    {l.lotDate} {l.lotLabel}（残 {n(l.quantity)}）
                  </option>
                ))}
              </select>
            </div>
            {field('inv-boxes', `箱数（1箱 ${b.unitsPerBox === null ? '—' : n(b.unitsPerBox)}個）`, boxes, setBoxes)}
          </>
        ) : null}
        {action === 'stocktake' ? (
          <>
            {field('inv-cd', '数えた預かり在庫（個）', countedDeposit, setCountedDeposit)}
            {b.adjustStockManaged ? field('inv-ca', '数えた調整用在庫（個）', countedAdjust, setCountedAdjust) : null}
            {field('inv-reason', '理由', reason, setReason, { type: 'text' })}
          </>
        ) : null}
        {action === 'opening' ? (
          <>
            {b.adjustStockManaged ? field('inv-adj', '調整用在庫（個）', adjust, setAdjust, { required: false }) : null}
            <fieldset className="ix-field">
              <legend>預かり在庫（検査日ごと）</legend>
              {openLots.map((l, k) => (
                <div key={k} className="ix-inlineform">
                  <label htmlFor={`inv-ld-${k}`}>検査日</label>
                  <input id={`inv-ld-${k}`} type="date" value={l.lotDate} onChange={(e) => setOpenLots((p) => p.map((x, j) => (j === k ? { ...x, lotDate: e.target.value } : x)))} />
                  <label htmlFor={`inv-lq-${k}`}>数量</label>
                  <input id={`inv-lq-${k}`} type="number" min={0} value={l.quantity} onChange={(e) => setOpenLots((p) => p.map((x, j) => (j === k ? { ...x, quantity: e.target.value } : x)))} />
                </div>
              ))}
              <button type="button" className="ix-btn" onClick={() => setOpenLots((p) => [...p, { lotDate: '', quantity: '' }])}>
                ロットを追加
              </button>
            </fieldset>
          </>
        ) : null}
      </div>
      {preview !== null ? (
        <div className="ix-impact" aria-live="polite">
          <b>登録した場合の見込み</b>
          <p>
            預かり在庫 {preview.depositDelta >= 0 ? '+' : ''}
            {n(preview.depositDelta)}個{b.adjustStockManaged ? ` ／ 調整用在庫 ${preview.adjustDelta >= 0 ? '+' : ''}${n(preview.adjustDelta)}個` : ''}
          </p>
          {preview.allocations.length > 0 ? (
            <ul>
              {preview.allocations.map((a) => (
                <li key={a.lotKey}>
                  {a.lotDate} のロットから {n(a.quantity)}個
                </li>
              ))}
            </ul>
          ) : null}
          {preview.issues.some((i) => i.kind === 'ADJ_NEGATIVE') ? (
            <label className="ix-checklist" htmlFor="inv-ack">
              <input id="inv-ack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              調整用在庫が不足しても記録する
            </label>
          ) : null}
          {preview.issues.some((i) => i.kind === 'LOT_NEGATIVE') ? <p className="ix-error" role="alert">預かり在庫が足りないため登録できません。</p> : null}
        </div>
      ) : null}
      {msg !== null ? (
        <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ix-notice' : 'ix-error'}>
          {msg.text}
        </p>
      ) : null}
      <div className="ix-btnrow">
        <button type="button" className="ix-btn" onClick={(e) => void submit(e, true)}>
          見込みを確認
        </button>
        <button type="submit" className="ix-btn primary" disabled={preview === null}>
          登録する
        </button>
      </div>
    </form>
  );
}

function MonthlyTab({ b }: { b: Balance }) {
  const [month, setMonth] = useState(() => currentMonthRangeJst().from.slice(0, 7));
  const [countBy, setCountBy] = useState<'INSPECTION_MONTH' | 'DELIVERY_MONTH'>('INSPECTION_MONTH');
  const [view, setView] = useState<MonthView | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiRequest<MonthView>('GET', `/inventory/${b.productId}/monthly?month=${month}&countBy=${countBy}`).then((r) => {
      if (!cancelled) setView(r.ok ? r.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [b.productId, month, countBy, b.movementCount]);
  const exportHref = `/api/v1/inventory/monthly/export?productId=${b.productId}&month=${month}&countBy=${countBy}`;
  return (
    <div>
      <div className="ix-filters">
        <div className="ix-field">
          <label htmlFor="inv-month">対象年月</label>
          <input id="inv-month" type="month" value={month} onChange={(e) => e.target.value !== '' && setMonth(e.target.value)} />
        </div>
        <div className="ix-field">
          <label htmlFor="inv-countby">月の数え方</label>
          <select id="inv-countby" value={countBy} onChange={(e) => setCountBy(e.target.value as typeof countBy)}>
            <option value="INSPECTION_MONTH">その月に検査した分</option>
            <option value="DELIVERY_MONTH">その月に納入した分</option>
          </select>
        </div>
        <a className="ix-btn primary" href={exportHref}>
          Excel で出力
        </a>
      </div>
      {view === null ? (
        <p className="ix-muted" aria-busy="true">読み込み中…</p>
      ) : (
        <div className="ix-tablewrap">
          <table>
            <caption>
              {b.code} {b.name} の在庫集計表（{month}）。預かり在庫 {n(view.totals.closeDeposit)}個、調整用在庫 {n(view.totals.closeAdjust)}個（月末）
            </caption>
            <thead>
              <tr>
                <th scope="col">日付</th>
                <th scope="col">ロット</th>
                <th scope="col" className="num">前日の調整用</th>
                <th scope="col" className="num">選別数</th>
                <th scope="col" className="num">不良</th>
                <th scope="col" className="num">納入</th>
                <th scope="col" className="num">調整用残</th>
                <th scope="col" className="num">1時間あたり</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.date} className={r.inMonth ? '' : 'ix-muted'}>
                  <td>{r.date}</td>
                  <td>{r.lotNo}</td>
                  <td className="num">{n(r.prevAdjust)}</td>
                  <td className="num">{n(r.selected)}</td>
                  <td className="num">{r.ngTotal > 0 ? n(r.ngTotal) : ''}</td>
                  <td className="num">{n(r.delivered)}</td>
                  <td className="num">{n(r.endAdjust)}</td>
                  <td className="num">{r.perHour === null ? '' : r.perHour.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>合計</th>
                <td className="num">{n(view.totals.selected)}</td>
                <td className="num">{n(view.totals.ngTotal)}</td>
                <td className="num">{n(view.totals.delivered)}</td>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
