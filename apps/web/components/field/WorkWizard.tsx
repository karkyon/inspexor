'use client';

/**
 * SCR-06〜09 作業日報 5 step（FR-003 / REQ-WRK-001）。
 * 顧客 → 品番・作業 → 人員・時間（工数を即時計算） → 数量・不良 → 確認・確定。
 * 報告者は本人のみ（SPEC-CONFLICT-G3-01: 代理入力は別CHG）。
 * CHG-004（提案書 P.8/P.9）: Step1 に作業場所、Step2 に使用車（任意）、Step4 に備考。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { computeBusinessTime, jstToInstant, minutesToHours, toJstParts, validateWorkSpan, type FieldIssue } from '@inspexor/domain';
import { buildWorkDraft, emptyWorkForm, normalizeWorkForm, validateWorkStep, workDetailToForm, REMARKS_MAX, WORK_STEPS, type WorkForm } from '../../lib/field/wizard';
import { canCreateReports, useFieldUser } from './FieldShell';
import { ErrorSummary, FieldError, StateBar, Stepper, issueFor } from './FieldParts';
import { nameOf, useFieldMasters, type FieldMasters } from './useFieldMasters';
import { useOnline } from './useOnline';
import { todayJst, useWizard } from './useWizard';
import { ConflictBanner, DonePanel, NotAllowed } from './WizardCommon';

const BASE = '/field/work-reports/new';
const TITLES = ['日付・報告者・お客様', '品番・作業内容', '作業者・作業時間', '数量・不良', '登録内容を確認'];
const STEP_PATHS: Record<number, string[]> = {
  1: ['/workDate', '/customerId', '/reporterId', '/workLocationId'],
  2: ['/productId', '/workTypeId', '/lotNo', '/vehicleId'],
  3: ['/workerIds', '/startAt', '/endAt'],
  4: ['/quantity', '/defects', '/remarks'],
};

/** 提案書 P.9 の表記: 実作業時間（休憩控除後）と総作業時間（作業者数×時間）を小数2桁の時間で示す（B-04） */
function actualHours(c: { regularMinutes: number; overtimeMinutes: number }): string {
  return `${minutesToHours(c.regularMinutes + c.overtimeMinutes)}H`;
}

function totalHours(c: { regularPersonMinutes: number; overtimePersonMinutes: number }): string {
  return `${minutesToHours(c.regularPersonMinutes + c.overtimePersonMinutes)}H`;
}

function useTimeCalc(f: WorkForm, masters: FieldMasters | null) {
  return useMemo(() => {
    if (masters === null || f.startTime === '' || f.endTime === '' || f.workerIds.length === 0) return null;
    try {
      const startAt = new Date(jstToInstant(f.workDate, f.startTime));
      const endAt = new Date(jstToInstant(f.workDate, f.endTime === '00:00' ? '24:00' : f.endTime));
      const span = validateWorkSpan(f.workDate, startAt, endAt);
      if (!span.ok) return null;
      const isHoliday = masters.holidays.some((h) => h.active && h.holidayDate === f.workDate);
      return { ...computeBusinessTime({ date: f.workDate, start: span.start, end: span.end, workers: f.workerIds.length, isHoliday }), isHoliday };
    } catch {
      return null;
    }
  }, [f.workDate, f.startTime, f.endTime, f.workerIds.length, masters]);
}

export function WorkWizard() {
  const user = useFieldUser();
  const online = useOnline();
  const { masters, lookup, loadedAt, error: masterError } = useFieldMasters(online);
  const w = useWizard<WorkForm>({
    type: 'work',
    userId: user.userId,
    basePath: BASE,
    maxStep: 5,
    initial: () => emptyWorkForm(todayJst(), user.userId),
    firstInvalidStep: (f) => {
      if (lookup === null) return null;
      for (let s = 1; s <= 4; s += 1) {
        if (validateWorkStep(s, f, lookup).length > 0) return s;
      }
      return null;
    },
    apiSegment: 'work-reports',
    detailToForm: (d) => workDetailToForm(d, (iso) => toJstParts(new Date(iso))),
    normalize: normalizeWorkForm,
  });
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [checked, setChecked] = useState(false);
  const calc = useTimeCalc(w.form, masters);

  if (!canCreateReports(user)) return <NotAllowed />;
  if (w.done !== null) return <DonePanel type="WORK" kind="作業日報" done={w.done} again={BASE} />;
  if (!w.loaded || lookup === null || masters === null) {
    return <p className="fx-muted" aria-busy="true">{masterError ?? '読み込み中…'}</p>;
  }
  const f = w.form;
  const step = w.step;
  // server の不良 index（送信順）を画面の不良種別 key に読み替え
  const sentDefects = Object.entries(f.defects).filter(([, q]) => Number(q) > 0).map(([id]) => id);
  const allIssues = [
    ...issues,
    ...w.serverIssues.map((i) => {
      const m = /^\/defects\/(\d+)\/.+$/.exec(i.path);
      const id = m !== null ? sentDefects[Number(m[1])] : undefined;
      return id !== undefined ? { ...i, path: `/defects/${id}` } : i;
    }),
  ];

  function next(e: FormEvent): void {
    e.preventDefault();
    if (lookup === null) return;
    const own = STEP_PATHS[step] ?? [];
    const found = validateWorkStep(step, f, lookup).filter((i) => own.some((p) => i.path === p || i.path.startsWith(`${p}/`)));
    setIssues(found);
    if (found.length === 0) w.goStep(step + 1);
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (lookup === null) return;
    const found = validateWorkStep(4, f, lookup);
    if (!checked) found.push({ path: '/confirmCheck', code: 'required', message: '「内容を確認しました」にチェックしてください。' });
    setIssues(found);
    if (found.length > 0) return;
    await w.submit(buildWorkDraft(f));
  }

  const hrefOf = (path: string): string | null => {
    const s = w.stepOfIssue(path);
    if (path === '/confirmCheck') return '#f-confirmCheck';
    if (s !== step) return `${BASE}?step=${s}`;
    const key = path.split('/')[1] ?? '';
    if (key === 'defects') return `#f-defect-${path.split('/')[2] ?? ''}`;
    if (key === 'startAt') return '#f-startTime';
    if (key === 'endAt') return '#f-endTime';
    return `#f-${key}`;
  };
  const invalid = (...paths: string[]) => issueFor(allIssues, ...paths) !== undefined || undefined;

  const products = masters.products.filter((p) => p.active && p.customerId === f.customerId);
  const product = masters.products.find((p) => p.id === f.productId);
  const workTypes = masters.workTypes.filter((x) => x.active && x.productId === f.productId);
  const defectTypes = masters.defects.filter((d) => d.active && d.productId === f.productId).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const quantity = Number(f.quantity) || 0;
  const defectTotal = Object.values(f.defects).reduce((s, q) => s + (Number(q) || 0), 0);
  const rate = quantity > 0 ? ((defectTotal / quantity) * 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : '0';

  const actions = (back: number | null, label: string, submit = false) => (
    <footer className="fx-actions">
      {back === null ? (
        <a className="fx-btn" href="/field">
          ← 戻る
        </a>
      ) : (
        <button type="button" className="fx-btn" onClick={() => w.goStep(back)} disabled={w.busy}>
          ← 戻る
        </button>
      )}
      <button type="submit" className="fx-btn primary" disabled={submit && (w.busy || !online)} aria-describedby={submit && !online ? 'offline-note' : undefined}>
        {submit && w.busy ? '登録中…' : label}
      </button>
    </footer>
  );

  return (
    <div className="fx-wizard">
      <StateBar online={online} lastSaved={w.lastSaved} storageOk={w.storageOk} loadedAt={loadedAt} />
      <Stepper steps={WORK_STEPS} current={step} label="作業日報の登録" />
      <header className="fx-pagetitle">
        <div>
          <small>作業日報を登録</small>
          <h1>{TITLES[step - 1]}</h1>
        </div>
        <span>{w.server.reportNo ?? 'WR 新規'} / 下書き</span>
      </header>
      <ConflictBanner error={w.apiError} onReload={() => void w.reloadFromServer()} onDiscard={w.discard} />
      <ErrorSummary issues={allIssues} hrefOf={hrefOf} />

      {step === 1 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <div className="fx-field">
              <label htmlFor="f-workDate">
                作業日<span className="fx-req">必須</span>
              </label>
              <input id="f-workDate" type="date" value={f.workDate} onChange={(e) => w.setForm((p) => ({ ...p, workDate: e.target.value }))} aria-invalid={invalid('/workDate')} aria-describedby="e-workDate" />
              <FieldError id="e-workDate" issue={issueFor(allIssues, '/workDate')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-reporterId">報告者</label>
              <input id="f-reporterId" readOnly value={f.reporterId === user.userId ? `${user.displayName}（本人）` : '元の報告者（事務所で修正中）'} aria-describedby="h-reporter e-reporterId" />
              <small id="h-reporter">{f.reporterId === user.userId ? '代理入力は現在対応していません。' : '確定済み報告の修正では報告者は変わりません。'}</small>
              <FieldError id="e-reporterId" issue={issueFor(allIssues, '/reporterId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-customerId">
                お客様<span className="fx-req">必須</span>
              </label>
              <select
                id="f-customerId"
                value={f.customerId}
                onChange={(e) =>
                  w.setForm((p) => (p.customerId === e.target.value ? p : { ...p, customerId: e.target.value, productId: '', workTypeId: '', defects: {} }))
                }
                aria-invalid={invalid('/customerId')}
                aria-describedby="e-customerId"
              >
                <option value="">選択してください</option>
                {masters.customers.filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <FieldError id="e-customerId" issue={issueFor(allIssues, '/customerId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-workLocationId">
                作業場所<span className="fx-opt">任意</span>
              </label>
              <select id="f-workLocationId" value={f.workLocationId} onChange={(e) => w.setForm((p) => ({ ...p, workLocationId: e.target.value }))} aria-invalid={invalid('/workLocationId')} aria-describedby="e-workLocationId">
                <option value="">選択しない</option>
                {masters.workLocations.filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <FieldError id="e-workLocationId" issue={issueFor(allIssues, '/workLocationId')} />
            </div>
          </section>
          {actions(null, '次へ進む →')}
        </form>
      ) : step === 2 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <div className="fx-field">
              <label htmlFor="f-productId">
                品番<span className="fx-req">必須</span>
              </label>
              <select
                id="f-productId"
                value={f.productId}
                onChange={(e) => w.setForm((p) => (p.productId === e.target.value ? p : { ...p, productId: e.target.value, workTypeId: '', defects: {} }))}
                aria-invalid={invalid('/productId')}
                aria-describedby="e-productId h-productId"
              >
                <option value="">選択してください</option>
                {products.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <small id="h-productId">{nameOf(masters.customers, f.customerId)} の有効な品番だけを表示しています。</small>
              <FieldError id="e-productId" issue={issueFor(allIssues, '/productId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-productName">品名</label>
              <input id="f-productName" readOnly value={product?.name ?? ''} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-workTypeId">
                作業内容<span className="fx-req">必須</span>
              </label>
              <select id="f-workTypeId" value={f.workTypeId} onChange={(e) => w.setForm((p) => ({ ...p, workTypeId: e.target.value }))} aria-invalid={invalid('/workTypeId')} aria-describedby="e-workTypeId">
                <option value="">{f.productId === '' ? '先に品番を選択してください' : '選択してください'}</option>
                {workTypes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <FieldError id="e-workTypeId" issue={issueFor(allIssues, '/workTypeId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-lotNo">
                ロット番号{product?.lotRequired === true ? <span className="fx-req">必須</span> : '（任意）'}
              </label>
              <input id="f-lotNo" type="text" maxLength={100} value={f.lotNo} onChange={(e) => w.setForm((p) => ({ ...p, lotNo: e.target.value }))} aria-invalid={invalid('/lotNo')} aria-describedby="e-lotNo h-lotNo" />
              <small id="h-lotNo">{product?.lotRequired === true ? 'この品番では入力必須です。' : '複数ロットはカンマ区切りで入力できます。'}</small>
              <FieldError id="e-lotNo" issue={issueFor(allIssues, '/lotNo')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-vehicleId">
                使用車<span className="fx-opt">任意</span>
              </label>
              <select id="f-vehicleId" value={f.vehicleId} onChange={(e) => w.setForm((p) => ({ ...p, vehicleId: e.target.value }))} aria-invalid={invalid('/vehicleId')} aria-describedby="e-vehicleId">
                <option value="">選択しない</option>
                {masters.vehicles.filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <FieldError id="e-vehicleId" issue={issueFor(allIssues, '/vehicleId')} />
            </div>
          </section>
          {actions(1, '次へ進む →')}
        </form>
      ) : step === 3 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <fieldset className="fx-field" style={{ maxWidth: 'none', border: 0, padding: 0, margin: 0 }} aria-describedby="e-workerIds">
              <legend>
                作業者<span className="fx-req">必須</span>（{f.workerIds.length}名選択中・50名まで）
              </legend>
              <div className="fx-workers" id="f-workerIds">
                {masters.workers.filter((x) => x.active).map((x) => {
                  const on = f.workerIds.includes(x.id);
                  return (
                    <label key={x.id} className={on ? 'on' : ''}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          w.setForm((p) => ({ ...p, workerIds: e.target.checked ? [...p.workerIds, x.id] : p.workerIds.filter((id) => id !== x.id) }))
                        }
                      />
                      {x.code} {x.name}
                    </label>
                  );
                })}
              </div>
              <FieldError id="e-workerIds" issue={issueFor(allIssues, '/workerIds')} />
            </fieldset>
            <div className="fx-twocol">
              <div className="fx-field">
                <label htmlFor="f-startTime">
                  開始時刻<span className="fx-req">必須</span>
                </label>
                <input id="f-startTime" type="time" step={300} value={f.startTime} onChange={(e) => w.setForm((p) => ({ ...p, startTime: e.target.value }))} aria-invalid={invalid('/startAt')} aria-describedby="e-startAt" />
                <FieldError id="e-startAt" issue={issueFor(allIssues, '/startAt')} />
              </div>
              <div className="fx-field">
                <label htmlFor="f-endTime">
                  終了時刻<span className="fx-req">必須</span>
                </label>
                <input id="f-endTime" type="time" step={300} value={f.endTime} onChange={(e) => w.setForm((p) => ({ ...p, endTime: e.target.value }))} aria-invalid={invalid('/endAt')} aria-describedby="e-endAt h-endTime" />
                <small id="h-endTime">5分刻み。日をまたぐ作業は入力できません（深夜0:00終了は 00:00）。</small>
                <FieldError id="e-endAt" issue={issueFor(allIssues, '/endAt')} />
              </div>
            </div>
            <div className="fx-timecalc" aria-live="polite">
              <div>
                <span>休憩時間（自動）</span>
                <b>{calc === null ? '—' : `${minutesToHours(calc.breakMinutes)}H`}</b>
                <small>12:00〜13:00 に重なる時間</small>
              </div>
              <div>
                <span>実作業時間</span>
                <b>{calc === null ? '—' : actualHours(calc)}</b>
              </div>
              <div>
                <span>総作業時間</span>
                <b>{calc === null ? '—' : totalHours(calc)}</b>
                <small>実作業時間 × 作業者数</small>
              </div>
            </div>
          </section>
          {actions(2, '次へ進む →')}
        </form>
      ) : step === 4 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <div className="fx-twocol">
              <div className="fx-field">
                <label htmlFor="f-quantity">
                  処理数量（個）<span className="fx-req">必須</span>
                </label>
                <input id="f-quantity" type="number" inputMode="numeric" min={0} max={999999} value={f.quantity} onChange={(e) => w.setForm((p) => ({ ...p, quantity: e.target.value }))} aria-invalid={invalid('/quantity')} aria-describedby="e-quantity" />
                <FieldError id="e-quantity" issue={issueFor(allIssues, '/quantity')} />
              </div>
              <div className="fx-field">
                <label htmlFor="f-good">良品数量（個）</label>
                <input id="f-good" readOnly value={Math.max(0, quantity - defectTotal).toLocaleString('ja-JP')} />
              </div>
            </div>
            <fieldset className="fx-picklist" aria-describedby="e-defects">
              <legend>不良内訳（該当するものだけ入力）</legend>
              {defectTypes.length === 0 ? <p className="fx-empty">この品番の不良種別は登録されていません。</p> : null}
              {defectTypes.map((d) => {
                const di = issueFor(allIssues, `/defects/${d.id}`);
                return (
                  <div key={d.id} className="fx-pick">
                    <span aria-hidden="true" />
                    <label htmlFor={`f-defect-${d.id}`}>
                      <b>{d.name}</b>
                      <small>{d.code}</small>
                    </label>
                    <div>
                      <input
                        id={`f-defect-${d.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        placeholder="0"
                        value={f.defects[d.id] ?? ''}
                        onChange={(e) => w.setForm((p) => ({ ...p, defects: { ...p.defects, [d.id]: e.target.value } }))}
                        aria-invalid={di !== undefined || undefined}
                        aria-describedby={`e-defect-${d.id}`}
                      />
                      <FieldError id={`e-defect-${d.id}`} issue={di} />
                    </div>
                  </div>
                );
              })}
            </fieldset>
            <FieldError id="e-defects" issue={allIssues.find((i) => i.path === '/defects')} />
            <div className="fx-field">
              <label htmlFor="f-remarks">
                備考<span className="fx-opt">任意</span>
              </label>
              <textarea id="f-remarks" rows={3} maxLength={REMARKS_MAX} value={f.remarks} onChange={(e) => w.setForm((p) => ({ ...p, remarks: e.target.value }))} aria-invalid={invalid('/remarks')} aria-describedby="h-remarks e-remarks" />
              <small id="h-remarks">{REMARKS_MAX}文字まで（例: 特記事項なし）</small>
              <FieldError id="e-remarks" issue={issueFor(allIssues, '/remarks')} />
            </div>
            <div className="fx-finalsummary" aria-live="polite">
              <div>
                <small>実作業時間</small>
                <b>{calc === null ? '—' : actualHours(calc)}</b>
              </div>
              <div>
                <small>総作業時間</small>
                <b>{calc === null ? '—' : totalHours(calc)}</b>
              </div>
              <div>
                <small>数量</small>
                <b>{quantity.toLocaleString('ja-JP')}個</b>
              </div>
              <div>
                <small>不良（不良率）</small>
                <b>
                  {defectTotal.toLocaleString('ja-JP')}個（{rate}%）
                </b>
              </div>
            </div>
          </section>
          {actions(3, '内容を確認 →')}
        </form>
      ) : (
        <form onSubmit={(e) => void confirm(e)} noValidate>
          <section className="fx-panel">
            <div className="fx-confirmcard">
              <header>
                <b>作業日報</b>
                <span className="fx-pill DRAFT">確定前</span>
              </header>
              <dl>
                <dt>作業日</dt>
                <dd>{f.workDate}</dd>
                <dt>報告者</dt>
                <dd>{f.reporterId === user.userId ? `${user.displayName}（本人）` : '元の報告者（事務所で修正中）'}</dd>
                <dt>お客様</dt>
                <dd>{nameOf(masters.customers, f.customerId)}</dd>
                <dt>作業場所</dt>
                <dd>{f.workLocationId === '' ? '—' : nameOf(masters.workLocations, f.workLocationId)}</dd>
                <dt>品番 / 品名</dt>
                <dd>{nameOf(masters.products, f.productId)}</dd>
                <dt>作業内容</dt>
                <dd>{nameOf(masters.workTypes, f.workTypeId)}</dd>
                <dt>ロット</dt>
                <dd>{f.lotNo.trim() === '' ? '—' : f.lotNo.trim()}</dd>
                <dt>使用車</dt>
                <dd>{f.vehicleId === '' ? '—' : nameOf(masters.vehicles, f.vehicleId)}</dd>
                <dt>作業者</dt>
                <dd>{f.workerIds.map((id) => nameOf(masters.workers, id)).join('、')}</dd>
                <dt>時間</dt>
                <dd>
                  {f.startTime}–{f.endTime === '00:00' ? '24:00' : f.endTime}
                  {calc !== null ? `（実作業時間 ${actualHours(calc)} / 総作業時間 ${totalHours(calc)}、休憩 ${minutesToHours(calc.breakMinutes)}H）` : ''}
                </dd>
                <dt>数量 / 不良</dt>
                <dd>
                  {quantity.toLocaleString('ja-JP')}個 / {defectTotal.toLocaleString('ja-JP')}個（{rate}%）
                </dd>
                <dt>備考</dt>
                <dd className="fx-prewrap">{f.remarks.trim() === '' ? '—' : f.remarks.trim()}</dd>
              </dl>
              <p className="fx-note">工数は確定時にサーバーで再計算されます（休日マスタを含む）。確定後の内容は変更できません。</p>
            </div>
            <label className="fx-confirmcheck" htmlFor="f-confirmCheck">
              <input id="f-confirmCheck" type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} aria-describedby="e-confirmCheck" />
              内容を確認しました
            </label>
            <FieldError id="e-confirmCheck" issue={issueFor(allIssues, '/confirmCheck')} />
          </section>
          {actions(4, '確定して登録', true)}
          {!online ? (
            <p id="offline-note" className="fx-muted">
              オフラインのため確定できません。通信が戻ると確定できます。
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
