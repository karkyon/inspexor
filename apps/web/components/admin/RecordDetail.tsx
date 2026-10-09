'use client';

/**
 * 事務所: 報告の詳細（提案書 P.6「詳細確認・修正」「日報PDF再出力」/ CHG-004 D2・D3）。
 *  - 表示: API-005/009 の最新版＋マスタ名称
 *  - PDF: API-024 の10分署名 URL でプレビュー・ダウンロード、API-025 regenerate で再出力（理由必須）
 *  - 修正: 確定済みは API-013 revise（理由必須）で新しい版の下書きを作り、現場と同じ入力画面で直して確定する。
 *          下書き中はそのまま入力画面で編集する。入力画面の利用は OFFICE（API-006/010 の権限）
 *  - 運搬費: 確定後は API-026 setDeliveryFee で入力・修正（版は作らない、監査あり）
 */
import { useCallback, useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { toJstParts } from '@inspexor/domain';
import { apiRequest } from '../../lib/api/client';
import { loadDraft, saveDraft } from '../../lib/field/draft-store';
import { deliveryDetailToForm, workDetailToForm } from '../../lib/field/wizard';
import { REVISABLE, documentStatusLabel, statusLabel, TYPE_LABEL, yenLabel } from '../../lib/records/labels';
import { newIdempotencyKey } from '../field/FieldParts';
import { fetchPdf, inlineUrl, pdfLabel } from '../field/PdfLinks';
import { useAdminUser } from './AdminShell';
import { label, useMasterNames, type NameMaps } from './useMasterNames';

type ReportType = 'WORK' | 'DELIVERY';
type Detail = Record<string, unknown> & { id: string; reportNo: string; status: string; version: number; revisionNo: number; documentStatus: string | null; documentId: string | null };

const MASTER_TYPES = ['customers', 'products', 'work-types', 'defects', 'workers', 'vehicles', 'work-locations'];

function jstTime(iso: unknown): string {
  return typeof iso === 'string' ? toJstParts(new Date(iso)).time : '—';
}

function hours(minutes: unknown): string {
  return typeof minutes === 'number' ? `${(minutes / 60).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}時間` : '—';
}

function WorkFields({ d, names }: { d: Detail; names: NameMaps | null }) {
  const defects = (d['defects'] as Array<{ defectTypeId: string; quantity: number }>) ?? [];
  const defectTotal = defects.reduce((s, x) => s + x.quantity, 0);
  return (
    <dl className="ix-dl">
      <dt>作業日</dt>
      <dd>{String(d['workDate'])}</dd>
      <dt>お客様</dt>
      <dd>{label(names, 'customers', d['customerId'] as string)}</dd>
      <dt>作業場所</dt>
      <dd>{label(names, 'work-locations', d['workLocationId'] as string | null)}</dd>
      <dt>品番</dt>
      <dd>{label(names, 'products', d['productId'] as string)}</dd>
      <dt>作業内容</dt>
      <dd>{label(names, 'work-types', d['workTypeId'] as string)}</dd>
      <dt>ロット</dt>
      <dd>{(d['lotNo'] as string | null) ?? '—'}</dd>
      <dt>使用車</dt>
      <dd>{label(names, 'vehicles', d['vehicleId'] as string | null)}</dd>
      <dt>作業者</dt>
      <dd>{((d['workerIds'] as string[]) ?? []).map((id) => label(names, 'workers', id)).join('、')}</dd>
      <dt>時間</dt>
      <dd>
        {jstTime(d['startAt'])}–{jstTime(d['endAt']) === '00:00' ? '24:00' : jstTime(d['endAt'])}（休憩 {String(d['breakMinutes'])}分）
      </dd>
      <dt>作業時間（人×時間）</dt>
      <dd>
        通常 {hours(d['regularPersonMinutes'])} / 時間外 {hours(d['overtimePersonMinutes'])}
      </dd>
      <dt>数量</dt>
      <dd>{Number(d['quantity']).toLocaleString('ja-JP')}個</dd>
      <dt>不良</dt>
      <dd>
        {defects.length === 0
          ? '不具合なし'
          : `${defects.map((x) => `${label(names, 'defects', x.defectTypeId)} ${x.quantity.toLocaleString('ja-JP')}`).join('、')}（計 ${defectTotal.toLocaleString('ja-JP')}個）`}
      </dd>
      <dt>備考</dt>
      <dd className="ix-prewrap">{(d['remarks'] as string | null) ?? '—'}</dd>
    </dl>
  );
}

function DeliveryFields({ d, names }: { d: Detail; names: NameMaps | null }) {
  const items = (d['items'] as Array<{ productId: string; quantity: number }>) ?? [];
  return (
    <>
      <dl className="ix-dl">
        <dt>運搬日</dt>
        <dd>{String(d['deliveryDate'])}</dd>
        <dt>運転者</dt>
        <dd>{label(names, 'workers', d['driverId'] as string)}</dd>
        <dt>お客様</dt>
        <dd>{label(names, 'customers', d['customerId'] as string)}</dd>
        <dt>使用車両</dt>
        <dd>{label(names, 'vehicles', d['vehicleId'] as string | null)}</dd>
        <dt>運搬回数</dt>
        <dd>{String(d['tripCount'])}回</dd>
        <dt>運搬費</dt>
        <dd>{yenLabel((d['deliveryFeeYen'] as number | null) ?? null)}</dd>
      </dl>
      <div className="ix-datatable ix-inner">
        <table>
          <thead>
            <tr>
              <th scope="col">品番</th>
              <th scope="col" className="num">
                数量
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.productId}>
                <td>{label(names, 'products', i.productId)}</td>
                <td className="num">{i.quantity.toLocaleString('ja-JP')}個</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PdfPanel({ type, d, canAct, onChanged }: { type: ReportType; d: Detail; canAct: boolean; onChanged: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const pdf = pdfLabel(type);

  useEffect(() => {
    setLink(null);
    if (d.documentStatus !== 'GENERATED') return;
    void fetchPdf(type, d.id).then((r) => {
      if (r.kind === 'ready') setLink({ url: r.url, expiresAt: r.expiresAt });
    });
  }, [type, d.id, d.documentStatus, d.documentId]);

  async function open(e: MouseEvent<HTMLAnchorElement>, inline: boolean): Promise<void> {
    if (link === null || Date.now() < link.expiresAt - 30_000) return;
    e.preventDefault();
    const r = await fetchPdf(type, d.id);
    if (r.kind === 'ready') {
      setLink({ url: r.url, expiresAt: r.expiresAt });
      window.location.assign(inline ? inlineUrl(r.url) : r.url);
    }
  }

  async function regenerate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (d.documentId === null) return;
    if (reason.trim() === '') {
      setMsg('再出力の理由を入力してください。');
      return;
    }
    setBusy(true);
    const res = await apiRequest('POST', `/documents/${d.documentId}/regenerate`, { expectedVersion: d.version, reason: reason.trim() }, { 'Idempotency-Key': newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      setMsg(`${pdf}の再出力を受け付けました。数秒後に新しい PDF が表示されます。`);
      setReason('');
      window.setTimeout(onChanged, 4000);
    } else {
      setMsg(res.error.message);
    }
  }

  return (
    <section className="ix-panel" aria-labelledby="pdf-title">
      <h2 id="pdf-title">{pdf}</h2>
      <p className="ix-muted">状態: {documentStatusLabel(d.status, d.documentStatus)}</p>
      {link !== null ? (
        <div className="ix-btnrow">
          <a className="ix-btn primary" href={inlineUrl(link.url)} target="_blank" rel="noopener" onClick={(e) => void open(e, true)}>
            {pdf}をプレビュー
          </a>
          <a className="ix-btn" href={link.url} onClick={(e) => void open(e, false)}>
            {pdf}をダウンロード
          </a>
        </div>
      ) : null}
      {canAct && d.documentId !== null && (d.documentStatus === 'GENERATED' || d.documentStatus === 'FAILED_FINAL') ? (
        <form className="ix-inlineform" onSubmit={(e) => void regenerate(e)}>
          <div className="ix-field">
            <label htmlFor="regen-reason">再出力の理由</label>
            <input id="regen-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="例: お客様から再送依頼" />
          </div>
          <button type="submit" className="ix-btn" disabled={busy}>
            {pdf}を再出力
          </button>
        </form>
      ) : null}
      {msg !== null ? (
        <p role="status" className="ix-muted">
          {msg}
        </p>
      ) : null}
    </section>
  );
}

function FeePanel({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const current = (d['deliveryFeeYen'] as number | null) ?? null;
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const t = value.trim().replace(/,/g, '');
    if (t !== '' && (!/^\d+$/.test(t) || Number(t) > 9_999_999)) {
      setMsg('運搬費は0〜9,999,999円の整数で入力するか、空欄（未確定）にしてください。');
      return;
    }
    setBusy(true);
    const res = await apiRequest('POST', `/delivery-reports/${d.id}/fee`, { expectedVersion: d.version, deliveryFeeYen: t === '' ? null : Number(t) });
    setBusy(false);
    if (res.ok) {
      setMsg('運搬費を保存しました。');
      onChanged();
    } else {
      setMsg(res.error.code === 'VERSION_CONFLICT' ? '他の利用者が更新しました。再読込してから入力してください。' : res.error.message);
    }
  }

  return (
    <section className="ix-panel" aria-labelledby="fee-title">
      <h2 id="fee-title">運搬費の入力</h2>
      <p className="ix-muted">按分等を確認した確定金額を入力します（自動計算はしません）。空欄で保存すると未確定に戻ります。</p>
      <form className="ix-inlineform" onSubmit={(e) => void save(e)}>
        <div className="ix-field">
          <label htmlFor="fee-value">運搬費（円）</label>
          <input id="fee-value" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder="未確定" />
        </div>
        <button type="submit" className="ix-btn primary" disabled={busy}>
          運搬費を保存
        </button>
      </form>
      {msg !== null ? (
        <p role="status" className="ix-muted">
          {msg}
        </p>
      ) : null}
    </section>
  );
}

function EditPanel({ type, d, onChanged }: { type: ReportType; d: Detail; onChanged: () => void }) {
  const user = useAdminUser();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draftType = type === 'WORK' ? 'work' : 'delivery';
  const editPath = type === 'WORK' ? '/field/work-reports/new?step=1' : '/field/deliveries/new?step=1';

  /** 下書き（最新版）を現場と同じ入力画面に読み込ませて開く */
  async function openEditor(): Promise<void> {
    const existing = loadDraft(user.userId, draftType);
    if (existing !== null && existing.serverId !== d.id) {
      setMsg(`この端末に作成中の${TYPE_LABEL[type]}の下書きがあります。先に入力画面で確定するか破棄してください。`);
      return;
    }
    const res = await apiRequest<Record<string, unknown>>('GET', `/${type === 'WORK' ? 'work-reports' : 'delivery-reports'}/${d.id}`);
    if (!res.ok) {
      setMsg(res.error.message);
      return;
    }
    const form = type === 'WORK' ? workDetailToForm(res.data, (iso) => toJstParts(new Date(iso))) : deliveryDetailToForm(res.data);
    const ok = saveDraft(user.userId, draftType, { step: 1, data: form, serverId: d.id, serverVersion: Number(res.data['version']), reportNo: d.reportNo });
    if (!ok) {
      setMsg('この端末に下書きを保存できません（ブラウザの設定を確認してください）。');
      return;
    }
    window.location.assign(editPath);
  }

  async function revise(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (reason.trim() === '') {
      setMsg('修正理由を入力してください。');
      return;
    }
    setBusy(true);
    const res = await apiRequest('POST', `/records/${type}/${d.id}/revise`, { expectedVersion: d.version, reason: reason.trim() }, { 'Idempotency-Key': newIdempotencyKey() });
    setBusy(false);
    if (!res.ok) {
      setMsg(res.error.code === 'VERSION_CONFLICT' ? '他の利用者が更新しました。再読込してください。' : res.error.message);
      onChanged();
      return;
    }
    await openEditor();
  }

  if (d.status === 'DRAFT') {
    return (
      <section className="ix-panel" aria-labelledby="edit-title">
        <h2 id="edit-title">修正</h2>
        <p className="ix-muted">この報告は下書き（版{d.revisionNo}）です。入力画面で直して確定すると、新しい{pdfLabel(type)}が作成されます。</p>
        <button type="button" className="ix-btn primary" onClick={() => void openEditor()}>
          入力画面で編集する
        </button>
        {msg !== null ? <p role="alert" className="ix-error">{msg}</p> : null}
      </section>
    );
  }
  if (!REVISABLE.includes(d.status)) return null;
  return (
    <section className="ix-panel" aria-labelledby="edit-title">
      <h2 id="edit-title">修正（新しい版を作成）</h2>
      <p className="ix-muted">確定済みの版{d.revisionNo}は残し、内容を写した新しい版を作ります。入力画面で直して確定すると、{pdfLabel(type)}も新しい版で作成されます。</p>
      <form className="ix-inlineform" onSubmit={(e) => void revise(e)}>
        <div className="ix-field">
          <label htmlFor="revise-reason">
            修正理由<span className="ix-req">必須</span>
          </label>
          <input id="revise-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="例: 数量の記入誤り" />
        </div>
        <button type="submit" className="ix-btn primary" disabled={busy}>
          修正を始める
        </button>
      </form>
      {msg !== null ? <p role="alert" className="ix-error">{msg}</p> : null}
    </section>
  );
}

export function RecordDetail({ type, id }: { type: ReportType; id: string }) {
  const user = useAdminUser();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = useMasterNames(MASTER_TYPES);
  const canAct = user.roles.includes('OFFICE') || user.roles.includes('ADMIN');
  const canEdit = user.roles.includes('OFFICE');

  const load = useCallback(async () => {
    const res = await apiRequest<Detail>('GET', `/${type === 'WORK' ? 'work-reports' : 'delivery-reports'}/${id}`);
    if (res.ok) {
      setD(res.data);
      setError(null);
    } else {
      setError(res.error.message);
    }
  }, [type, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <section className="ix-panel" role="alert">
        <h1>報告を表示できません</h1>
        <p>{error}</p>
        <a href="/admin/records">報告一覧へ戻る</a>
      </section>
    );
  }
  if (d === null) return <p className="ix-muted">読み込み中…</p>;

  return (
    <div className="ix-page">
      <header className="ix-pagehead">
        <div>
          <a href="/admin/records" className="ix-small">
            ← 報告一覧
          </a>
          <h1>
            {TYPE_LABEL[type]} {d.reportNo}
          </h1>
          <p>
            <span className={`ix-pill ${d.status.toLowerCase()}`}>{statusLabel(d.status)}</span> 版{d.revisionNo}
            {typeof d['confirmedAt'] === 'string' ? `・確定 ${toJstParts(new Date(d['confirmedAt'] as string)).date} ${toJstParts(new Date(d['confirmedAt'] as string)).time}` : ''}
          </p>
        </div>
      </header>
      <div className="ix-detailgrid">
        <section className="ix-panel" aria-labelledby="body-title">
          <h2 id="body-title">報告内容</h2>
          {type === 'WORK' ? <WorkFields d={d} names={names} /> : <DeliveryFields d={d} names={names} />}
        </section>
        <div className="ix-sidecol">
          <PdfPanel type={type} d={d} canAct={canAct} onChanged={() => void load()} />
          {type === 'DELIVERY' && canAct && d.status !== 'DRAFT' && d.status !== 'BILLING_LOCKED' ? <FeePanel key={d.version} d={d} onChanged={() => void load()} /> : null}
          {canEdit ? <EditPanel type={type} d={d} onChanged={() => void load()} /> : null}
        </div>
      </div>
    </div>
  );
}
