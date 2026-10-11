'use client';

/**
 * SCR-13 マスター管理: 一覧（v6.0 ワイヤーフレーム: 左に10種＋件数、検索・有効のみ、表、ページング）。
 * API-014 listMasters。編集・追加は ADMIN のみ（OFFICE/AUDITOR は参照）。
 */
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../lib/api/client';
import { MASTER_DEFS, type MasterType } from '../../lib/masters/definitions';
import { LIST_COLUMNS, NAV_LABEL, fieldLabel, formatCell, masterNav } from '../../lib/masters/ui';
import { canEditMasters, hasFeature, useAdminUser } from './AdminShell';
import { useLookups } from './useLookups';

type Row = Record<string, unknown> & { id: string; active: boolean; version: number };
const PAGE_SIZE = 25;

export function MasterScreen({ type, notice }: { readonly type: MasterType; readonly notice?: string | undefined }) {
  const user = useAdminUser();
  const editable = canEditMasters(user);
  const billing = hasFeature(user, 'billing');
  const nav = masterNav(billing);
  const def = MASTER_DEFS[type];
  const { lookups } = useLookups();
  const [counts, setCounts] = useState<Partial<Record<MasterType, number>>>({});
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'active' | 'all' | 'inactive'>('active');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      masterNav(billing).map(async (n) => {
        const res = await apiRequest<unknown[]>('GET', `/masters/${n.type}?pageSize=1`);
        return [n.type, res.ok ? (res.meta?.total ?? 0) : undefined] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setCounts(Object.fromEntries(entries.filter(([, n]) => n !== undefined)) as Partial<Record<MasterType, number>>);
    });
    return () => {
      cancelled = true;
    };
  }, [billing]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    void apiRequest<Row[]>('GET', `/masters/${type}?page=${page}&pageSize=${PAGE_SIZE}`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRows(res.data);
        setTotal(res.meta?.total ?? res.data.length);
      } else {
        setError(res.error.message);
        setRows([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [type, page]);

  const columns = LIST_COLUMNS[type];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (activeFilter === 'active' && !row.active) return false;
      if (activeFilter === 'inactive' && row.active) return false;
      if (q === '') return true;
      return columns.some((c) => formatCell(type, c, row[c], lookups).toLowerCase().includes(q));
    });
  }, [rows, query, activeFilter, columns, type, lookups]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const label = NAV_LABEL[type];

  return (
    <div className="ix-page">
      <div className="ix-pagehead">
        <div>
          <small>設定</small>
          <h1>マスター管理</h1>
          <p>使用中データは削除せず、適用期間または無効化で管理します。</p>
        </div>
        {editable ? (
          <a className="ix-btn primary" href={`/admin/masters/${type}/new`}>
            ＋ {label}を追加
          </a>
        ) : (
          <span className="ix-muted">参照のみ（編集は管理者）</span>
        )}
      </div>
      {notice !== undefined ? (
        <p className="ix-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="ix-masterlayout">
        <nav className="ix-masternav" aria-label="マスター種別">
          {nav.map((n) => (
            <a key={n.type} href={`/admin/masters/${n.type}`} className={n.type === type ? 'active' : ''} aria-current={n.type === type ? 'page' : undefined}>
              {n.label}
              <b>{counts[n.type] ?? ''}</b>
            </a>
          ))}
        </nav>
        <section aria-labelledby="master-list-title">
          <h2 id="master-list-title" className="ix-visually-hidden">
            {label}の一覧
          </h2>
          <div className="ix-searchbar">
            <label className="ix-visually-hidden" htmlFor="master-search">
              表示中のページ内を検索
            </label>
            <input id="master-search" type="search" placeholder={`${label}をコード・名称で検索（表示中のページ内）`} value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="ix-visually-hidden" htmlFor="master-active">
              状態で絞り込み
            </label>
            <select id="master-active" value={activeFilter} onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}>
              <option value="active">有効のみ</option>
              <option value="all">すべて</option>
              <option value="inactive">無効のみ</option>
            </select>
          </div>
          <div className="ix-datatable">
            {error !== null ? (
              <p role="alert" className="ix-error">
                {error}
              </p>
            ) : rows === null ? (
              <p className="ix-muted" aria-live="polite">
                読み込み中…
              </p>
            ) : visible.length === 0 ? (
              <div className="ix-empty">
                <p>{rows.length === 0 ? `${label}はまだ登録されていません。` : '条件に一致するデータがありません。'}</p>
                {editable && rows.length === 0 ? <a href={`/admin/masters/${type}/new`}>＋ {label}を追加</a> : null}
              </div>
            ) : (
              <div className="ix-tablewrap">
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c} scope="col" className={c === 'amountYen' || c === 'unitPrice' ? 'num' : undefined}>
                          {fieldLabel(type, c)}
                        </th>
                      ))}
                      <th scope="col">状態</th>
                      <th scope="col">
                        <span className="ix-visually-hidden">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.id}>
                        {columns.map((c, i) => (
                          <td key={c} className={c === 'amountYen' || c === 'unitPrice' ? 'num' : undefined}>
                            {i === 0 ? <b>{formatCell(type, c, row[c], lookups)}</b> : formatCell(type, c, row[c], lookups)}
                          </td>
                        ))}
                        <td>
                          <span className={`ix-pill ${row.active ? 'approved' : 'draft'}`}>{row.active ? '有効' : '無効'}</span>
                        </td>
                        <td>
                          <a href={`/admin/masters/${type}/${row.id}`} aria-label={`${formatCell(type, columns[0] as string, row[columns[0] as string], lookups)} を${editable ? '編集' : '表示'}`}>
                            {editable ? '編集' : '表示'}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <footer>
              <span>
                {total === 0 ? '0件' : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} / ${total}件`}
              </span>
              <div>
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="前のページ">
                  ‹
                </button>
                <span aria-live="polite">
                  {page} / {pages}
                </span>
                <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="次のページ">
                  ›
                </button>
              </div>
            </footer>
          </div>
          <p className="ix-muted ix-small">{def.retroactive !== 'NONE' ? '過去の期間に掛かる変更・無効化は理由の入力が必要です。保存前に「影響を確認」で対象件数を確認できます。' : ''}</p>
        </section>
      </div>
    </div>
  );
}
