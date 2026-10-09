'use client';

/**
 * SCR-02 現場ホーム: 登録メニュー、端末下書きの再開、最近の登録（API-012 listRecords。FIELD は自分の分のみ: CHG-002）。
 */
import { useEffect, useState } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { loadDraft } from '../../lib/field/draft-store';
import { canCreateReports, useFieldUser } from './FieldShell';
import { StateBar } from './FieldParts';
import { PdfLinks } from './PdfLinks';
import { useOnline } from './useOnline';
import { statusLabel } from './WizardCommon';

interface RecordRow {
  readonly id: string;
  readonly reportNo: string;
  readonly status: string;
  readonly type: 'WORK' | 'DELIVERY';
  readonly businessDate: string;
  readonly documentStatus: string | null;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** 帳票の状態（G4）。DRAFT 以外で帳票が未完了なら「作成中」、最終失敗は事務所対応 */
function documentLabel(status: string, documentStatus: string | null): string {
  if (status === 'DRAFT') return '';
  if (documentStatus === 'GENERATED') return '・帳票 作成済';
  if (documentStatus === 'FAILED_FINAL') return '・帳票 エラー（事務所で対応）';
  return '・帳票 作成中';
}

export function FieldHome() {
  const user = useFieldUser();
  const online = useOnline();
  const [records, setRecords] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<{ work: number | null; delivery: number | null }>({ work: null, delivery: null });
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setDrafts({ work: loadDraft(user.userId, 'work')?.step ?? null, delivery: loadDraft(user.userId, 'delivery')?.step ?? null });
  }, [user.userId]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void apiRequest<RecordRow[]>('GET', '/records?pageSize=10').then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRecords(res.data);
        setError(null);
      } else {
        setError(res.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [online]);

  const jst = toJstParts(now);
  const [y, m, d] = jst.date.split('-').map(Number) as [number, number, number];
  const dow = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const creatable = canCreateReports(user);

  return (
    <div>
      <StateBar online={online} lastSaved={null} storageOk loadedAt={null} />
      <section className="fx-welcome">
        <div>
          <small>
            {y}年{m}月{d}日（{dow}）
          </small>
          <h1>{user.displayName}さん、お疲れさまです</h1>
          <p>{creatable ? '今日はどの実績を登録しますか？' : 'このロールでは実績の登録はできません（閲覧のみ）。'}</p>
        </div>
        <div className="fx-clock" aria-hidden="true">
          {jst.time}
          <small>JST</small>
        </div>
      </section>

      {creatable ? (
        <nav className="fx-bigactions" aria-label="登録メニュー">
          <a className="fx-bigaction work" href="/field/work-reports/new?step=1">
            <i aria-hidden="true">⚙</i>
            <b>作業日報を登録</b>
            <span>検品・加工・選別の実績</span>
            <em aria-hidden="true">→</em>
          </a>
          <a className="fx-bigaction delivery" href="/field/deliveries/new?step=1">
            <i aria-hidden="true">▣</i>
            <b>運搬実績を登録</b>
            <span>集荷・納品した品番と数量</span>
            <em aria-hidden="true">→</em>
          </a>
        </nav>
      ) : null}

      {creatable && (drafts.work !== null || drafts.delivery !== null) ? (
        <section className="fx-card" style={{ marginBottom: 18 }} aria-labelledby="draft-title">
          <header>
            <h2 id="draft-title">この端末の下書き</h2>
          </header>
          <div className="fx-resume">
            {drafts.work !== null ? (
              <a className="fx-btn" href={`/field/work-reports/new?step=${drafts.work}`}>
                作業日報の下書きを再開（Step {drafts.work}）
              </a>
            ) : null}
            {drafts.delivery !== null ? (
              <a className="fx-btn" href={`/field/deliveries/new?step=${drafts.delivery}`}>
                運搬実績の下書きを再開（Step {drafts.delivery}）
              </a>
            ) : null}
            <small className="fx-muted">下書きは24時間・ログアウトで削除されます。</small>
          </div>
        </section>
      ) : null}

      <section className="fx-card" aria-labelledby="recent-title">
        <header>
          <h2 id="recent-title">最近の登録</h2>
        </header>
        {!online ? (
          <p className="fx-empty">オフラインのため表示できません。</p>
        ) : error !== null ? (
          <p className="fx-empty" role="alert">
            {error}
          </p>
        ) : records === null ? (
          <p className="fx-empty" aria-busy="true">
            読み込み中…
          </p>
        ) : records.length === 0 ? (
          <p className="fx-empty">まだ登録がありません。{creatable ? '上のメニューから登録できます。' : ''}</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {records.map((r) => (
              <li key={r.id} className="fx-record">
                <span className={`fx-pill ${r.status}`}>{statusLabel(r.status)}</span>
                <b>{r.reportNo}</b>
                <span>
                  {r.type === 'WORK' ? '作業日報' : '運搬実績'}
                  <small className="fx-muted"> {documentLabel(r.status, r.documentStatus)}</small>
                </span>
                <time dateTime={r.businessDate}>{r.businessDate}</time>
                {r.documentStatus === 'GENERATED' ? (
                  <div className="fx-record-pdf">
                    <PdfLinks type={r.type} id={r.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
