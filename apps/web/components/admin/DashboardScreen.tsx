'use client';

/**
 * SCR-10 管理ダッシュボード（CHG-007、FR-017。v6.0 ワイヤーフレーム: KPI・直近7日の実績・要対応）。
 * APPROVAL_ENABLED のときだけ左ナビに出る。API-029 GET /dashboard（無効時は 404）。
 */
import { useCallback, useEffect, useState } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { TYPE_LABEL } from '../../lib/records/labels';

interface Dashboard {
  readonly asOf: string;
  readonly today: string;
  readonly kpis: {
    readonly pendingApproval: number;
    readonly pendingOver24h: number;
    readonly todayWorkConfirmed: number;
    readonly todayWorkDraft: number;
    readonly todayDeliveryCount: number;
    readonly todayDeliveryProducts: number;
    readonly failedDocuments: number;
  };
  readonly daily: ReadonlyArray<{ date: string; work: number; delivery: number }>;
  readonly attention: ReadonlyArray<{ kind: 'DOCUMENT_FAILED' | 'APPROVAL_OVERDUE' | 'REJECTED'; type: 'WORK' | 'DELIVERY'; reportId: string; reportNo: string; at: string }>;
}

const ATTENTION: Record<Dashboard['attention'][number]['kind'], { icon: string; cls: string; label: string }> = {
  DOCUMENT_FAILED: { icon: '!', cls: 'red', label: '帳票の作成に失敗しました（再出力が必要です）' },
  APPROVAL_OVERDUE: { icon: '⌛', cls: 'amber', label: '承認待ちが24時間を超えています' },
  REJECTED: { icon: '↩', cls: 'blue', label: '差戻し中（修正待ち）' },
};

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min}分前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

export function DashboardScreen() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const res = await apiRequest<Dashboard>('GET', '/dashboard');
    setBusy(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.status === 404 ? 'ダッシュボードは有効になっていません（承認ワークフローを有効にすると使えます）。' : res.error.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = data === null ? new Date() : new Date(data.asOf);
  const max = Math.max(1, ...(data?.daily ?? []).map((d) => Math.max(d.work, d.delivery)));
  const asOf = data === null ? null : toJstParts(new Date(data.asOf));

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <small className="ix-muted">管理</small>
          <h1>ダッシュボード</h1>
          <p>{asOf === null ? '読み込み中…' : `${data?.today ?? ''}・最終更新 ${asOf.time}`}</p>
        </div>
        <div className="ix-btnrow">
          <a className="ix-btn primary" href="/admin/records?status=SUBMITTED&dateFrom=&dateTo=">
            承認待ちを確認
          </a>
          <button type="button" className="ix-btn" onClick={() => void load()} disabled={busy} aria-busy={busy}>
            更新
          </button>
        </div>
      </header>
      {error !== null ? (
        <section className="ix-panel" role="alert">
          <p>{error}</p>
        </section>
      ) : null}
      {data !== null ? (
        <>
          <section className="ix-kpis ix-kpis4" aria-label="主要指標">
            <div>
              <span>承認待ち</span>
              <b>{data.kpis.pendingApproval}</b>
              <small className={data.kpis.pendingOver24h > 0 ? 'ix-amber' : undefined}>{data.kpis.pendingOver24h > 0 ? `${data.kpis.pendingOver24h}件が24時間超過` : '24時間超過なし'}</small>
            </div>
            <div>
              <span>本日の作業日報</span>
              <b>{data.kpis.todayWorkConfirmed + data.kpis.todayWorkDraft}</b>
              <small>
                確定 {data.kpis.todayWorkConfirmed} / 下書き {data.kpis.todayWorkDraft}
              </small>
            </div>
            <div>
              <span>本日の運搬</span>
              <b>{data.kpis.todayDeliveryCount}</b>
              <small>合計 {data.kpis.todayDeliveryProducts}品番</small>
            </div>
            <div>
              <span>帳票の処理失敗</span>
              <b className={data.kpis.failedDocuments > 0 ? 'ix-red' : undefined}>{data.kpis.failedDocuments}</b>
              <small className={data.kpis.failedDocuments > 0 ? 'ix-red' : undefined}>{data.kpis.failedDocuments > 0 ? '再出力が必要です' : '問題なし'}</small>
            </div>
          </section>
          <div className="ix-dashgrid">
            <section className="ix-datatable" aria-labelledby="chart-title">
              <header className="ix-cardhead">
                <h2 id="chart-title">直近7日間の実績</h2>
                <span className="ix-legend">
                  <i className="work" aria-hidden="true" />
                  作業日報 <i className="delivery" aria-hidden="true" />
                  運搬
                </span>
              </header>
              <div className="ix-bars" role="img" aria-label={data.daily.map((d) => `${dateLabel(d.date)} 作業${d.work}件 運搬${d.delivery}件`).join('、')}>
                {data.daily.map((d) => (
                  <div key={d.date}>
                    <div className="ix-barpair">
                      <i className="work" style={{ height: `${(d.work / max) * 100}%` }} title={`作業日報 ${d.work}件`} />
                      <i className="delivery" style={{ height: `${(d.delivery / max) * 100}%` }} title={`運搬 ${d.delivery}件`} />
                    </div>
                    <span>
                      {dateLabel(d.date).replace(/（.+/, '')}
                      <br />
                      {dateLabel(d.date).replace(/^[^（]+/, '')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="ix-visually-hidden">
              <table>
                <caption>直近7日間の確定済み件数</caption>
                <thead>
                  <tr>
                    <th>日付</th>
                    <th>作業日報</th>
                    <th>運搬</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{d.work}</td>
                      <td>{d.delivery}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
            <section className="ix-datatable ix-attention" aria-labelledby="att-title">
              <header className="ix-cardhead">
                <h2 id="att-title">要対応</h2>
                <span className="ix-muted ix-small">{data.attention.length}件</span>
              </header>
              {data.attention.length === 0 ? (
                <p className="ix-empty">対応が必要な項目はありません。</p>
              ) : (
                <ul>
                  {data.attention.map((a) => (
                    <li key={`${a.kind}-${a.reportId}`}>
                      <span className={`ix-dot ${ATTENTION[a.kind].cls}`} aria-hidden="true">
                        {ATTENTION[a.kind].icon}
                      </span>
                      <a href={`/admin/records/${a.type === 'WORK' ? 'work' : 'delivery'}/${a.reportId}`}>
                        <b>{ATTENTION[a.kind].label}</b>
                        <small>
                          {TYPE_LABEL[a.type]} {a.reportNo}
                        </small>
                      </a>
                      <time dateTime={a.at}>{ago(a.at, now)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
