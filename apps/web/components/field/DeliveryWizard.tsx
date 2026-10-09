'use client';

/**
 * SCR-03〜05 運搬 3 step（FR-002 / REQ-DLV-001）。1報告=1便（DEC-002）。
 * Step1 基本（運搬日・運転者・お客様・使用車両）→ Step2 品番・数量・運搬回数・運搬費（任意）→ Step3 確認・確定。
 * CHG-004（提案書 P.7）: 運搬費は空欄で保存でき、事務所が後から入力・修正する。自動計算はしない。
 */
import { useState, type FormEvent } from 'react';
import type { FieldIssue } from '@inspexor/domain';
import { buildDeliveryDraft, deliveryDetailToForm, emptyDeliveryForm, feeOf, normalizeDeliveryForm, validateDeliveryStep, DELIVERY_STEPS, type DeliveryForm } from '../../lib/field/wizard';
import { canCreateReports, useFieldUser } from './FieldShell';
import { ErrorSummary, FieldError, StateBar, Stepper, issueFor } from './FieldParts';
import { nameOf, useFieldMasters } from './useFieldMasters';
import { useOnline } from './useOnline';
import { todayJst, useWizard } from './useWizard';
import { ConflictBanner, DonePanel, NotAllowed } from './WizardCommon';

const BASE = '/field/deliveries/new';

function feeLabel(raw: string): string {
  const fee = feeOf(raw);
  return fee === null || fee === 'invalid' ? '未確定（事務所で入力）' : `${fee.toLocaleString('ja-JP')}円`;
}

export function DeliveryWizard() {
  const user = useFieldUser();
  const online = useOnline();
  const { masters, lookup, loadedAt, error: masterError } = useFieldMasters(online);
  const w = useWizard<DeliveryForm>({
    type: 'delivery',
    userId: user.userId,
    basePath: BASE,
    maxStep: 3,
    initial: () => emptyDeliveryForm(todayJst()),
    firstInvalidStep: (f) => {
      if (lookup === null) return null;
      if (validateDeliveryStep(1, f, lookup).length > 0) return 1;
      if (validateDeliveryStep(2, f, lookup).length > 0) return 2;
      return null;
    },
    apiSegment: 'delivery-reports',
    detailToForm: deliveryDetailToForm,
    normalize: normalizeDeliveryForm,
  });
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [checked, setChecked] = useState(false);

  if (!canCreateReports(user)) return <NotAllowed />;
  if (w.done !== null) return <DonePanel type="DELIVERY" kind="運搬実績" done={w.done} again={BASE} />;
  if (!w.loaded || lookup === null || masters === null) {
    return <p className="fx-muted" aria-busy="true">{masterError ?? '読み込み中…'}</p>;
  }
  const f = w.form;
  const step = w.step;
  const order = Object.keys(f.items);
  // server の明細 index（送信順＝選択順）を画面の品番 key に読み替える
  const allIssues = [
    ...issues,
    ...w.serverIssues.map((i) => {
      const m = /^\/items\/(\d+)\/(.+)$/.exec(i.path);
      const pid = m !== null ? order[Number(m[1])] : undefined;
      return pid !== undefined && m !== null ? { ...i, path: `/items/${pid}/${m[2]}` } : i;
    }),
  ];

  function next(e: FormEvent): void {
    e.preventDefault();
    if (lookup === null) return;
    const found = validateDeliveryStep(step, f, lookup).filter((i) => step === 1 || !['/deliveryDate', '/driverId', '/customerId', '/vehicleId'].includes(i.path));
    setIssues(found);
    if (found.length === 0) w.goStep(step + 1);
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (lookup === null) return;
    const found = validateDeliveryStep(2, f, lookup);
    if (!checked) found.push({ path: '/confirmCheck', code: 'required', message: '「内容を確認しました」にチェックしてください。' });
    setIssues(found);
    if (found.length > 0) return;
    await w.submit(buildDeliveryDraft(f));
  }

  const hrefOf = (path: string): string | null => {
    const key = path.split('/')[1] ?? '';
    const s = w.stepOfIssue(path);
    if (s !== step) return `${BASE}?step=${s}`;
    if (key === 'items') return '#f-items';
    return `#f-${key}`;
  };
  const customerProducts = masters.products.filter((p) => p.active && p.customerId === f.customerId);
  const selected = Object.entries(f.items);
  const total = selected.reduce((sum, [, q]) => sum + (Number(q) || 0), 0);

  return (
    <div className="fx-wizard">
      <StateBar online={online} lastSaved={w.lastSaved} storageOk={w.storageOk} loadedAt={loadedAt} />
      <Stepper steps={DELIVERY_STEPS} current={step} label="運搬実績の登録" />
      <header className="fx-pagetitle">
        <div>
          <small>運搬実績を登録{w.server.reportNo !== null ? `（${w.server.reportNo}）` : ''}</small>
          <h1>{step === 1 ? '運搬の基本情報' : step === 2 ? '運搬した品番と数量' : '登録内容を確認'}</h1>
        </div>
        <span>下書きは自動保存されます</span>
      </header>
      <ConflictBanner error={w.apiError} onReload={() => void w.reloadFromServer()} onDiscard={w.discard} />
      <ErrorSummary issues={allIssues} hrefOf={hrefOf} />

      {step === 1 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <div className="fx-field">
              <label htmlFor="f-deliveryDate">
                運搬日<span className="fx-req">必須</span>
              </label>
              <input id="f-deliveryDate" type="date" value={f.deliveryDate} onChange={(e) => w.setForm((p) => ({ ...p, deliveryDate: e.target.value }))} aria-invalid={issueFor(allIssues, '/deliveryDate') !== undefined || undefined} aria-describedby="e-deliveryDate" />
              <FieldError id="e-deliveryDate" issue={issueFor(allIssues, '/deliveryDate')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-driverId">
                運転者<span className="fx-req">必須</span>
              </label>
              <select id="f-driverId" value={f.driverId} onChange={(e) => w.setForm((p) => ({ ...p, driverId: e.target.value }))} aria-invalid={issueFor(allIssues, '/driverId') !== undefined || undefined} aria-describedby="e-driverId">
                <option value="">選択してください</option>
                {masters.workers.filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <FieldError id="e-driverId" issue={issueFor(allIssues, '/driverId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-customerId">
                お客様<span className="fx-req">必須</span>
              </label>
              <select
                id="f-customerId"
                value={f.customerId}
                onChange={(e) => w.setForm((p) => ({ ...p, customerId: e.target.value, items: p.customerId === e.target.value ? p.items : {} }))}
                aria-invalid={issueFor(allIssues, '/customerId') !== undefined || undefined}
                aria-describedby="e-customerId h-customerId"
              >
                <option value="">選択してください</option>
                {masters.customers.filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
              </select>
              <small id="h-customerId">選択したお客様の品番だけを次の画面に表示します。お客様を変えると選択済みの品番は外れます。</small>
              <FieldError id="e-customerId" issue={issueFor(allIssues, '/customerId')} />
            </div>
            <div className="fx-field">
              <label htmlFor="f-vehicleId">
                使用車両<span className="fx-opt">任意</span>
              </label>
              <select id="f-vehicleId" value={f.vehicleId} onChange={(e) => w.setForm((p) => ({ ...p, vehicleId: e.target.value }))} aria-invalid={issueFor(allIssues, '/vehicleId') !== undefined || undefined} aria-describedby="e-vehicleId">
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
          <footer className="fx-actions">
            <a className="fx-btn" href="/field">
              ← 戻る
            </a>
            <button type="submit" className="fx-btn primary">
              次へ進む →
            </button>
          </footer>
        </form>
      ) : step === 2 ? (
        <form onSubmit={next} noValidate>
          <section className="fx-panel">
            <p className="fx-muted" style={{ margin: 0 }}>
              お客様: <b>{nameOf(masters.customers, f.customerId)}</b>
            </p>
            {customerProducts.length === 0 ? (
              <p className="fx-empty">このお客様に有効な品番がありません。管理者にマスターの登録を依頼してください。</p>
            ) : (
              <fieldset className="fx-picklist" id="f-items" aria-describedby="e-items">
                <legend className="fx-visually-hidden">運搬した品番と数量</legend>
                {customerProducts.map((p) => {
                  const on = p.id in f.items;
                  const qIssue = issueFor(allIssues, `/items/${p.id}/quantity`);
                  return (
                    <div key={p.id} className={`fx-pick${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        id={`f-pick-${p.id}`}
                        checked={on}
                        onChange={(e) =>
                          w.setForm((prev) => {
                            const items = { ...prev.items };
                            if (e.target.checked) items[p.id] = items[p.id] ?? '';
                            else delete items[p.id];
                            return { ...prev, items };
                          })
                        }
                      />
                      <label htmlFor={`f-pick-${p.id}`}>
                        <b>{p.code}</b>
                        <small>{p.name}</small>
                      </label>
                      <div>
                        <label className="fx-visually-hidden" htmlFor={`f-item-${p.id}`}>
                          {p.code} の数量
                        </label>
                        <input
                          id={`f-item-${p.id}`}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={999999}
                          placeholder="数量（個）"
                          disabled={!on}
                          value={f.items[p.id] ?? ''}
                          onChange={(e) => w.setForm((prev) => ({ ...prev, items: { ...prev.items, [p.id]: e.target.value } }))}
                          aria-invalid={qIssue !== undefined || undefined}
                          aria-describedby={`e-item-${p.id}`}
                        />
                        <FieldError id={`e-item-${p.id}`} issue={qIssue} />
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            )}
            <FieldError id="e-items" issue={allIssues.find((i) => i.path === '/items')} />
            <div className="fx-summaryline" aria-live="polite">
              <div>
                <span>対象品番</span>
                <b>{selected.length}品番</b>
              </div>
              <div>
                <span>合計数量</span>
                <b>{total.toLocaleString('ja-JP')}個</b>
              </div>
            </div>
            <div className="fx-twocol">
              <div className="fx-field">
                <label htmlFor="f-tripCount">
                  運搬回数（回）<span className="fx-req">必須</span>
                </label>
                <input id="f-tripCount" type="number" inputMode="numeric" min={1} max={99} value={f.tripCount} onChange={(e) => w.setForm((p) => ({ ...p, tripCount: e.target.value }))} aria-invalid={issueFor(allIssues, '/tripCount') !== undefined || undefined} aria-describedby="e-tripCount" />
                <FieldError id="e-tripCount" issue={issueFor(allIssues, '/tripCount')} />
              </div>
              <div className="fx-field">
                <label htmlFor="f-deliveryFeeYen">
                  運搬費（円）<span className="fx-opt">任意・後入力可</span>
                </label>
                <input id="f-deliveryFeeYen" type="text" inputMode="numeric" placeholder="未確定なら空欄" value={f.deliveryFee} onChange={(e) => w.setForm((p) => ({ ...p, deliveryFee: e.target.value }))} aria-invalid={issueFor(allIssues, '/deliveryFeeYen') !== undefined || undefined} aria-describedby="h-deliveryFeeYen e-deliveryFeeYen" />
                <small id="h-deliveryFeeYen">空欄のまま保存できます。金額は事務所で確認後に入力・修正します。</small>
                <FieldError id="e-deliveryFeeYen" issue={issueFor(allIssues, '/deliveryFeeYen')} />
              </div>
            </div>
          </section>
          <footer className="fx-actions">
            <button type="button" className="fx-btn" onClick={() => w.goStep(1)}>
              ← 戻る
            </button>
            <button type="submit" className="fx-btn primary">
              次へ進む →
            </button>
          </footer>
        </form>
      ) : (
        <form onSubmit={(e) => void confirm(e)} noValidate>
          <section className="fx-panel">
            <div className="fx-confirmcard">
              <header>
                <b>運搬実績</b>
                <span className="fx-pill DRAFT">1便</span>
              </header>
              <dl>
                <dt>運搬日</dt>
                <dd>{f.deliveryDate}</dd>
                <dt>運転者</dt>
                <dd>{nameOf(masters.workers, f.driverId)}</dd>
                <dt>お客様</dt>
                <dd>{nameOf(masters.customers, f.customerId)}</dd>
                <dt>使用車両</dt>
                <dd>{f.vehicleId === '' ? '—' : nameOf(masters.vehicles, f.vehicleId)}</dd>
                <dt>運搬回数</dt>
                <dd>{f.tripCount}回</dd>
                <dt>運搬費</dt>
                <dd>{feeLabel(f.deliveryFee)}</dd>
              </dl>
              <table>
                <thead>
                  <tr>
                    <th scope="col">品番</th>
                    <th scope="col">品名</th>
                    <th scope="col" className="num">
                      数量
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selected.map(([pid, q]) => {
                    const p = masters.products.find((x) => x.id === pid);
                    return (
                      <tr key={pid}>
                        <td>{p?.code}</td>
                        <td>{p?.name}</td>
                        <td className="num">{Number(q).toLocaleString('ja-JP')}個</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="fx-note">運搬費は自動計算しません。未確定の場合は事務所が後から入力・修正します。</p>
            </div>
            <label className="fx-confirmcheck" htmlFor="f-confirmCheck">
              <input id="f-confirmCheck" type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} aria-describedby="e-confirmCheck" />
              内容を確認しました
            </label>
            <FieldError id="e-confirmCheck" issue={issueFor(allIssues, '/confirmCheck')} />
          </section>
          <footer className="fx-actions">
            <button type="button" className="fx-btn" onClick={() => w.goStep(2)} disabled={w.busy}>
              ← 戻る
            </button>
            <button type="submit" className="fx-btn primary" disabled={w.busy || !online} aria-describedby={!online ? 'offline-note' : undefined}>
              {w.busy ? '登録中…' : '確定して登録'}
            </button>
          </footer>
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
