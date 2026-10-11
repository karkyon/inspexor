'use client';

/**
 * SCR-02 現場ホーム: 登録メニュー、端末下書きの再開、最近の登録（API-012 listRecords。FIELD は自分の分のみ: CHG-002）。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { loadDraft, saveDraft } from '../../lib/field/draft-store';
import { deliveryDetailToForm, workDetailToForm } from '../../lib/field/wizard';
import { canCreateReports, useFieldUser } from './FieldShell';
import { newIdempotencyKey, StateBar } from './FieldParts';
import { PdfLinks } from './PdfLinks';
import { useOnline } from './useOnline';
import { statusLabel } from './WizardCommon';

interface RecordRow {
  readonly id: string;
  readonly reportNo: string;
  readonly status: string;
  readonly version: number;
  readonly type: 'WORK' | 'DELIVERY';
  readonly businessDate: string;
  readonly documentStatus: string | null;
  /** CHG-007: 直近の承認・差戻し・取消 */
  readonly decision?: { readonly action: string; readonly reason: string | null } | null;
}

/**
 * CHG-007: 差戻し・取消された自分の報告を直す（API-013 revise で新しい版の下書きを作り、入力画面に読み込む）。
 * 確定済みの版と判断の記録は残る。直して確定すると新しい版の帳票が作られ、再び承認待ちになる。
 */
function RejectedFix({ r, userId }: { r: RecordRow; userId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftType = r.type === 'WORK' ? 'work' : 'delivery';

  async function start(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (reason.trim() === '') {
      setMsg('修正内容を入力してください。');
      return;
    }
    const existing = loadDraft(userId, draftType);
    if (existing !== null && existing.serverId !== r.id) {
      setMsg(`この端末に作成中の${r.type === 'WORK' ? '作業日報' : '運搬実績'}の下書きがあります。先に確定するか破棄してください。`);
      return;
    }
    setBusy(true);
    const rv = await apiRequest('POST', `/records/${r.type}/${r.id}/revise`, { expectedVersion: r.version, reason: reason.trim() }, { 'Idempotency-Key': newIdempotencyKey() });
    if (!rv.ok) {
      setBusy(false);
      setMsg(rv.error.code === 'VERSION_CONFLICT' ? '他の利用者が更新しました。画面を再読込してください。' : rv.error.message);
      return;
    }
    const res = await apiRequest<Record<string, unknown>>('GET', `/${r.type === 'WORK' ? 'work-reports' : 'delivery-reports'}/${r.id}`);
    setBusy(false);
    if (!res.ok) {
      setMsg(res.error.message);
      return;
    }
    const form = r.type === 'WORK' ? workDetailToForm(res.data, (iso) => toJstParts(new Date(iso))) : deliveryDetailToForm(res.data);
    if (!saveDraft(userId, draftType, { step: 1, data: form, serverId: r.id, serverVersion: Number(res.data['version']), reportNo: r.reportNo })) {
      setMsg('この端末に下書きを保存できません（ブラウザの設定を確認してください）。');
      return;
    }
    window.location.assign(r.type === 'WORK' ? '/field/work-reports/new?step=1' : '/field/deliveries/new?step=1');
  }

  return (
    <div className="fx-rejected">
      <p>
        <b>{r.status === 'REJECTED' ? '差戻し理由' : '取消理由'}:</b> {r.decision?.reason ?? '—'}
      </p>
      {open ? (
        <form onSubmit={(e) => void start(e)} className="fx-rejected-form">
          <label htmlFor={`fix-${r.id}`}>修正内容</label>
          <input id={`fix-${r.id}`} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="例: 不良数を訂正" />
          <button type="submit" className="fx-btn primary" disabled={busy}>
            入力画面で直す
          </button>
        </form>
      ) : (
        <button type="button" className="fx-btn" onClick={() => setOpen(true)}>
          修正する
        </button>
      )}
      {msg !== null ? (
        <p role="alert" className="fx-error">
          {msg}
        </p>
      ) : null}
    </div>
  );
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
                {(r.status === 'REJECTED' || r.status === 'REVOKED') && creatable ? <RejectedFix r={r} userId={user.userId} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
