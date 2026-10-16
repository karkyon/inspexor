'use client';

/**
 * 事務所: 報告一覧（提案書 P.6「報告一覧・確認」/ CHG-004 D6）。API-012 listRecords。
 * 作業日報と運搬実績を日付順に表示し、期間・種別・お客様・品番・状態で絞り込む。行から詳細へ。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { apiRequest } from '../../lib/api/client';
import { currentMonthRangeJst, documentStatusLabel, statusLabel, TYPE_LABEL, yenLabel } from '../../lib/records/labels';
import { hasFeature, useAdminUser } from './AdminShell';
import { label, useMasterNames } from './useMasterNames';

interface Row {
  readonly id: string;
  readonly reportNo: string;
  readonly status: string;
  readonly documentStatus: string | null;
  readonly type: 'WORK' | 'DELIVERY';
  readonly businessDate: string;
  readonly revisionNo: number;
  readonly customerId: string;
  readonly productIds: string[];
  readonly quantity: number;
  readonly tripCount: number | null;
  readonly deliveryFeeYen: number | null;
}

const PAGE_SIZE = 50;
const FILTER_KEYS = ['dateFrom', 'dateTo', 'type', 'customerId', 'productId', 'status'] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

export function RecordsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const month = useMemo(() => currentMonthRangeJst(), []);
  const applied: Filters = {
    dateFrom: params.get('dateFrom') ?? month.from,
    dateTo: params.get('dateTo') ?? month.to,
    type: params.get('type') ?? '',
    customerId: params.get('customerId') ?? '',
    productId: params.get('productId') ?? '',
    status: params.get('status') ?? '',
  };
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [form, setForm] = useState<Filters>(applied);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const names = useMasterNames(['customers', 'products']);
  const user = useAdminUser();
  // CHG-007: 承認が有効なときは承認済・差戻し・取消でも絞り込める
  const approval = hasFeature(user, 'approval');
  const query = new URLSearchParams(Object.entries(applied).filter(([, v]) => v !== '')).toString();

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void apiRequest<Row[]>('GET', `/records?${query}&page=${page}&pageSize=${PAGE_SIZE}`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRows(res.data);
        setTotal(res.meta?.total ?? 0);
        setError(null);
      } else {
        setError(res.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query, page]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const q = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== ''));
    router.push(`${pathname}?${q.toString()}`);
  }

  function goPage(p: number): void {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    router.push(`${pathname}?${q.toString()}`);
  }

  const customers = [...(names?.['customers']?.values() ?? [])].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  const products = [...(names?.['products']?.values() ?? [])]
    .filter((p) => form.customerId === '' || p.customerId === form.customerId)
    .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">事務所</small>
          <h1>報告一覧</h1>
          <p>作業日報と運搬実績を日付順に表示します。報告番号から詳細の確認・修正・PDF の再出力ができます。</p>
        </div>
      </header>

      <form className="ix-panel ix-filters" onSubmit={submit} aria-label="絞り込み">
        <div className="ix-field">
          <label htmlFor="q-dateFrom">期間（から）</label>
          <input id="q-dateFrom" type="date" value={form.dateFrom} onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))} />
        </div>
        <div className="ix-field">
          <label htmlFor="q-dateTo">期間（まで）</label>
          <input id="q-dateTo" type="date" value={form.dateTo} onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))} />
        </div>
        <div className="ix-field">
          <label htmlFor="q-type">種別</label>
          <select id="q-type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="">すべて（作業・運搬）</option>
            <option value="WORK">作業日報</option>
            <option value="DELIVERY">運搬実績</option>
          </select>
        </div>
        <div className="ix-field">
          <label htmlFor="q-customerId">お客様</label>
          <select id="q-customerId" value={form.customerId} onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value, productId: '' }))}>
            <option value="">すべて</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ix-field">
          <label htmlFor="q-productId">品番</label>
          <select id="q-productId" value={form.productId} onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}>
            <option value="">すべて</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ix-field">
          <label htmlFor="q-status">状態</label>
          <select id="q-status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
            <option value="">すべて</option>
            {(approval ? ['DRAFT', 'CONFIRMED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED', ...(hasFeature(user, 'billing') ? ['BILLING_LOCKED'] : [])] : ['DRAFT', 'CONFIRMED', 'SUBMITTED']).map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="ix-filteractions">
          <button type="submit" className="ix-btn primary">
            絞り込む
          </button>
        </div>
      </form>

      <section className="ix-datatable compact" aria-labelledby="records-title" aria-busy={rows === null}>
        <h2 id="records-title" className="ix-visually-hidden">
          報告
        </h2>
        {error !== null ? (
          <p role="alert" className="ix-error">
            {error}
          </p>
        ) : rows === null ? (
          <p className="ix-muted">読み込み中…</p>
        ) : rows.length === 0 ? (
          <p className="ix-empty">条件に合う報告はありません。期間や絞り込みを変えてください。</p>
        ) : (
          <div className="ix-tablewrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">日付</th>
                  <th scope="col">種別</th>
                  <th scope="col">報告番号</th>
                  <th scope="col">お客様</th>
                  <th scope="col">品番</th>
                  <th scope="col" className="num">
                    数量
                  </th>
                  <th scope="col" className="num">
                    運搬回数
                  </th>
                  <th scope="col" className="num">
                    運搬費
                  </th>
                  <th scope="col">状態</th>
                  <th scope="col">帳票</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const first = label(names, 'products', r.productIds[0]);
                  return (
                    <tr key={r.id}>
                      <td>{r.businessDate}</td>
                      <td>{TYPE_LABEL[r.type]}</td>
                      <td>
                        <a href={`/admin/records/${r.type === 'WORK' ? 'work' : 'delivery'}/${r.id}`}>{r.reportNo}</a>
                        {r.revisionNo > 1 ? <small className="ix-muted"> 版{r.revisionNo}</small> : null}
                      </td>
                      <td className="wrap">{label(names, 'customers', r.customerId)}</td>
                      <td className="wrap">{r.productIds.length > 1 ? `${first} ほか${r.productIds.length - 1}品番` : first}</td>
                      <td className="num">{r.quantity.toLocaleString('ja-JP')}個</td>
                      <td className="num">{r.tripCount === null ? '—' : `${r.tripCount}回`}</td>
                      <td className="num">{r.type === 'DELIVERY' ? yenLabel(r.deliveryFeeYen) : '—'}</td>
                      <td>
                        <span className={`ix-pill ${r.status.toLowerCase()}`}>{statusLabel(r.status)}</span>
                      </td>
                      <td>{documentStatusLabel(r.status, r.documentStatus)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <footer>
          <span className="ix-muted">
            {total.toLocaleString('ja-JP')}件（{page}/{pages}ページ）
          </span>
          <span>
            <button type="button" disabled={page <= 1} onClick={() => goPage(page - 1)} aria-label="前のページ">
              ‹
            </button>
            <button type="button" disabled={page >= pages} onClick={() => goPage(page + 1)} aria-label="次のページ">
              ›
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
