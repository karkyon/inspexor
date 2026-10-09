'use client';

/**
 * 事務所: 月次集計（提案書 P.6/P.10 / CHG-004 D4）。API-027 で集計し、API-028 で Excel（全シート）・CSV（表示中の表）を出力。
 * 年月・お客様・品番・報告種別で絞り込み、作業個数・不良数・作業時間、運搬数量・回数・手入力運搬費を表示する。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { minutesToHours } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { currentMonthRangeJst } from '../../lib/records/labels';
import { useMasterNames } from './useMasterNames';

interface Totals {
  workCount: number;
  workQuantity: number;
  defectQuantity: number;
  actualMinutes: number;
  personMinutes: number;
  deliveryCount: number;
  deliveryQuantity: number;
  tripCount: number;
  deliveryFeeYen: number;
  deliveryFeeUnsetCount: number;
}

interface View {
  month: string;
  from: string;
  to: string;
  totals: Totals;
  daily: Array<Totals & { date: string }>;
  byProduct: Array<{ productId: string; workQuantity: number; defectQuantity: number; actualMinutes: number; personMinutes: number; deliveryQuantity: number }>;
  byWorkType: Array<{ productId: string; workTypeId: string; workCount: number; workQuantity: number; defectQuantity: number; actualMinutes: number; personMinutes: number }>;
  rows: Array<
    | { type: 'WORK'; reportId: string; reportNo: string; revisionNo: number; date: string; customerId: string; productId: string; workTypeId: string; quantity: number; defectQuantity: number; actualMinutes: number; personMinutes: number }
    | { type: 'DELIVERY'; reportId: string; reportNo: string; revisionNo: number; date: string; customerId: string; items: Array<{ productId: string; quantity: number }>; tripCount: number; deliveryFeeYen: number | null }
  >;
  names: { customers: Record<string, { code: string; name: string }>; products: Record<string, { code: string; name: string }>; workTypes: Record<string, { name: string }> };
}

const TABS = [
  { key: 'daily', label: '日別' },
  { key: 'product', label: '品番別' },
  { key: 'worktype', label: '作業内容別' },
  { key: 'detail', label: '明細' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const n = (v: number) => v.toLocaleString('ja-JP');
const hh = (m: number) => `${minutesToHours(m)}H`;

export function MonthlyScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const thisMonth = useMemo(() => currentMonthRangeJst().from.slice(0, 7), []);
  const applied = {
    month: params.get('month') ?? thisMonth,
    customerId: params.get('customerId') ?? '',
    productId: params.get('productId') ?? '',
    type: params.get('type') ?? '',
  };
  const [form, setForm] = useState(applied);
  const [tab, setTab] = useState<Tab>('daily');
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = useMasterNames(['customers', 'products']);
  const query = new URLSearchParams(Object.entries(applied).filter(([, v]) => v !== '')).toString();

  useEffect(() => {
    let cancelled = false;
    setView(null);
    void apiRequest<View>('GET', `/reports/monthly?${query}`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setView(res.data);
        setError(null);
      } else {
        setError(res.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    router.push(`${pathname}?${new URLSearchParams(Object.entries(form).filter(([, v]) => v !== '')).toString()}`);
  }

  const customers = [...(names?.['customers']?.values() ?? [])].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  const products = [...(names?.['products']?.values() ?? [])].filter((p) => form.customerId === '' || p.customerId === form.customerId).sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  const pn = (id: string) => view?.names.products[id];
  const exportBase = `/api/v1/reports/monthly/export?${query}`;
  const t = view?.totals;

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">事務所</small>
          <h1>月次集計</h1>
          <p>確定済みの作業日報・運搬実績を集計します。運搬費は入力された金額の合計で、按分や請求額の計算はしません。</p>
        </div>
      </header>

      <form className="ix-panel ix-filters ix-filters4" onSubmit={submit} aria-label="集計条件">
        <div className="ix-field">
          <label htmlFor="m-month">対象年月</label>
          <input id="m-month" type="month" value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))} required />
        </div>
        <div className="ix-field">
          <label htmlFor="m-customerId">お客様</label>
          <select id="m-customerId" value={form.customerId} onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value, productId: '' }))}>
            <option value="">すべて</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ix-field">
          <label htmlFor="m-type">報告種別</label>
          <select id="m-type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="">すべて（作業／運搬）</option>
            <option value="WORK">作業日報</option>
            <option value="DELIVERY">運搬実績</option>
          </select>
        </div>
        <div className="ix-field">
          <label htmlFor="m-productId">品番</label>
          <select id="m-productId" value={form.productId} onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}>
            <option value="">すべて</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ix-filteractions">
          <button type="submit" className="ix-btn primary">
            集計する
          </button>
        </div>
      </form>

      {error !== null ? (
        <p role="alert" className="ix-panel ix-error">
          {error}
        </p>
      ) : view === null || t === undefined ? (
        <p className="ix-muted" aria-busy="true">
          集計中…
        </p>
      ) : (
        <>
          <section className="ix-kpis" aria-label={`${view.month} の集計`}>
            <div>
              <span>総作業個数</span>
              <b>{n(t.workQuantity)}</b>
              <small>作業日報 {n(t.workCount)}件</small>
            </div>
            <div>
              <span>総不良個数</span>
              <b>{n(t.defectQuantity)}</b>
            </div>
            <div>
              <span>実作業時間</span>
              <b>{hh(t.actualMinutes)}</b>
              <small>総作業時間（人×時間）{hh(t.personMinutes)}</small>
            </div>
            <div>
              <span>運搬数量</span>
              <b>{n(t.deliveryQuantity)}</b>
              <small>運搬実績 {n(t.deliveryCount)}件</small>
            </div>
            <div>
              <span>運搬回数</span>
              <b>{n(t.tripCount)}回</b>
            </div>
            <div>
              <span>手入力運搬費</span>
              <b>¥{n(t.deliveryFeeYen)}</b>
              <small>{t.deliveryFeeUnsetCount > 0 ? `未入力 ${t.deliveryFeeUnsetCount}件` : '未入力なし'}</small>
            </div>
          </section>

          <section className="ix-datatable" aria-label="集計表">
            <div className="ix-tabbar">
              <div role="tablist" aria-label="表の切替">
                {TABS.map((x) => (
                  <button key={x.key} type="button" role="tab" id={`tab-${x.key}`} aria-selected={tab === x.key} aria-controls="monthly-panel" className={tab === x.key ? 'active' : ''} onClick={() => setTab(x.key)}>
                    {x.label}
                  </button>
                ))}
              </div>
              <div className="ix-btnrow">
                <a className="ix-btn primary" href={`${exportBase}&format=xlsx`}>
                  Excel で出力（全シート）
                </a>
                <a className="ix-btn" href={`${exportBase}&format=csv&sheet=${tab}`}>
                  CSV で出力（{TABS.find((x) => x.key === tab)?.label}）
                </a>
              </div>
            </div>
            <div className="ix-tablewrap" role="tabpanel" id="monthly-panel" aria-labelledby={`tab-${tab}`}>
              {view.rows.length === 0 ? (
                <p className="ix-empty">この条件の確定済み報告はありません。</p>
              ) : tab === 'daily' ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">日付</th>
                      <th scope="col" className="num">作業個数</th>
                      <th scope="col" className="num">不良個数</th>
                      <th scope="col" className="num">実作業時間</th>
                      <th scope="col" className="num">総作業時間</th>
                      <th scope="col" className="num">運搬数量</th>
                      <th scope="col" className="num">運搬回数</th>
                      <th scope="col" className="num">運搬費</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.daily.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td className="num">{n(d.workQuantity)}</td>
                        <td className="num">{n(d.defectQuantity)}</td>
                        <td className="num">{hh(d.actualMinutes)}</td>
                        <td className="num">{hh(d.personMinutes)}</td>
                        <td className="num">{n(d.deliveryQuantity)}</td>
                        <td className="num">{d.deliveryCount > 0 ? `${n(d.tripCount)}回` : '—'}</td>
                        <td className="num">{d.deliveryCount > 0 ? `¥${n(d.deliveryFeeYen)}${d.deliveryFeeUnsetCount > 0 ? `（未入力${d.deliveryFeeUnsetCount}）` : ''}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : tab === 'product' ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">品番</th>
                      <th scope="col">品名</th>
                      <th scope="col" className="num">作業個数</th>
                      <th scope="col" className="num">不良個数</th>
                      <th scope="col" className="num">実作業時間</th>
                      <th scope="col" className="num">総作業時間</th>
                      <th scope="col" className="num">運搬数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.byProduct.map((p) => (
                      <tr key={p.productId}>
                        <td>{pn(p.productId)?.code}</td>
                        <td>{pn(p.productId)?.name}</td>
                        <td className="num">{n(p.workQuantity)}</td>
                        <td className="num">{n(p.defectQuantity)}</td>
                        <td className="num">{hh(p.actualMinutes)}</td>
                        <td className="num">{hh(p.personMinutes)}</td>
                        <td className="num">{n(p.deliveryQuantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : tab === 'worktype' ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">品番</th>
                      <th scope="col">作業内容</th>
                      <th scope="col" className="num">件数</th>
                      <th scope="col" className="num">作業個数</th>
                      <th scope="col" className="num">不良個数</th>
                      <th scope="col" className="num">実作業時間</th>
                      <th scope="col" className="num">総作業時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.byWorkType.map((w) => (
                      <tr key={`${w.productId}:${w.workTypeId}`}>
                        <td>{pn(w.productId)?.code}</td>
                        <td>{view.names.workTypes[w.workTypeId]?.name}</td>
                        <td className="num">{n(w.workCount)}</td>
                        <td className="num">{n(w.workQuantity)}</td>
                        <td className="num">{n(w.defectQuantity)}</td>
                        <td className="num">{hh(w.actualMinutes)}</td>
                        <td className="num">{hh(w.personMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">日付</th>
                      <th scope="col">種別</th>
                      <th scope="col">報告番号</th>
                      <th scope="col">品番</th>
                      <th scope="col" className="num">数量</th>
                      <th scope="col" className="num">不良</th>
                      <th scope="col" className="num">実作業時間</th>
                      <th scope="col" className="num">運搬回数／運搬費</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr key={r.reportId}>
                        <td>{r.date}</td>
                        <td>{r.type === 'WORK' ? '作業' : '運搬'}</td>
                        <td>
                          <a href={`/admin/records/${r.type === 'WORK' ? 'work' : 'delivery'}/${r.reportId}`}>{r.reportNo}</a>
                          {r.revisionNo > 1 ? <small className="ix-muted"> 版{r.revisionNo}</small> : null}
                        </td>
                        {r.type === 'WORK' ? (
                          <>
                            <td>{pn(r.productId)?.code}</td>
                            <td className="num">{n(r.quantity)}個</td>
                            <td className="num">{n(r.defectQuantity)}</td>
                            <td className="num">{hh(r.actualMinutes)}</td>
                            <td className="num">—</td>
                          </>
                        ) : (
                          <>
                            <td>
                              {r.items
                                .filter((i) => applied.productId === '' || i.productId === applied.productId)
                                .map((i) => pn(i.productId)?.code)
                                .join(' / ')}
                            </td>
                            <td className="num">{n(r.items.filter((i) => applied.productId === '' || i.productId === applied.productId).reduce((s, i) => s + i.quantity, 0))}個</td>
                            <td className="num">—</td>
                            <td className="num">—</td>
                            <td className="num">
                              {r.tripCount}回／{r.deliveryFeeYen === null ? '未入力' : `¥${n(r.deliveryFeeYen)}`}
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <footer>
              <span className="ix-muted">
                {view.from} 〜 {view.to}・確定済み {n(view.rows.length)}件
              </span>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
