'use client';

/**
 * 作業日報 STEP4 の在庫の欄（CHG-018、SK-2026-08-MINI-09 5章・モック「在庫あり」）。
 * 在庫を管理する品番・INVENTORY_ENABLED・利用開始の残高の登録済みのときだけ出す。箱数・1箱回す・納入（日付は作業日と別）・確定前の見込みを示す。
 */
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../lib/api/client';
import { computeInventoryEffect, suggestBoxes } from '../../lib/field/inventory-effect';
import type { WorkForm } from '../../lib/field/wizard';
import { FieldError, issueFor } from './FieldParts';
import type { FieldIssue } from '@inspexor/domain';

interface Balance {
  readonly unitsPerBox: number;
  readonly adjustStockManaged: boolean;
  readonly adjustLowThreshold: number;
  readonly deposit: number;
  readonly adjust: number;
  readonly hasOpening: boolean;
  readonly openingDate: string | null;
}

const num = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : 0);
const fmt = (n: number): string => n.toLocaleString('ja-JP');

export function InventoryBlock(props: {
  readonly form: WorkForm;
  readonly setForm: (update: (prev: WorkForm) => WorkForm) => void;
  readonly productName: string;
  readonly quantity: number;
  readonly defectTotal: number;
  readonly issues: readonly FieldIssue[];
  readonly online: boolean;
}) {
  const { form: f, setForm } = props;
  const [bal, setBal] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 箱数を本人が入力・編集した（または保存済みの値がある）なら、数量が変わっても自動では書き換えない
  const boxTouched = useRef(f.boxCount !== '');

  useEffect(() => {
    if (!props.online) return;
    let cancelled = false;
    void apiRequest<Balance>('GET', `/work-reports/inventory-preview?productId=${encodeURIComponent(f.productId)}&asOf=${encodeURIComponent(f.workDate)}`).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setBal(r.data);
        setError(null);
      } else setError('在庫の残高を読み込めませんでした。');
    });
    return () => {
      cancelled = true;
    };
  }, [f.productId, f.workDate, props.online]);

  // 箱数は、本人が触るまで「処理数量 ÷ 入数」（四捨五入）に自動で合わせる。数量が未入力の間は空欄のまま
  useEffect(() => {
    if (bal === null || !bal.hasOpening || boxTouched.current) return;
    const next = props.quantity > 0 ? String(suggestBoxes(props.quantity, bal.unitsPerBox)) : '';
    setForm((p) => (p.boxCount === next ? p : { ...p, boxCount: next }));
  }, [bal, props.quantity, setForm]);

  if (error !== null) return <p className="fx-note" role="alert">{error}</p>;
  if (bal === null) return null;
  if (!bal.hasOpening) {
    return (
      <section className="fx-invblock" aria-label="在庫">
        <h3>在庫</h3>
        <p className="fx-note">この品番は、まだ在庫の利用開始（開始時の残高）が登録されていないため、在庫は動きません。事務所の「在庫」画面で登録してください。</p>
      </section>
    );
  }
  if (bal.openingDate !== null && f.workDate < bal.openingDate) {
    return (
      <section className="fx-invblock" aria-label="在庫">
        <h3>在庫</h3>
        <p className="fx-note">作業日が在庫の利用開始日（{bal.openingDate}）より前のため、在庫は動きません。</p>
      </section>
    );
  }
  const boxCount = num(f.boxCount);
  const dq = num(f.deliveredQuantity);
  const eff = computeInventoryEffect({ unitsPerBox: bal.unitsPerBox, adjustManaged: bal.adjustStockManaged, adjustLowThreshold: bal.adjustLowThreshold, deposit: bal.deposit, adjust: bal.adjust, quantity: props.quantity, defectTotal: props.defectTotal, boxCount, replenishBoxes: num(f.replenishBoxes), deliveredQuantity: dq });
  const set = <K extends keyof WorkForm>(key: K, value: WorkForm[K]): void => setForm((p) => ({ ...p, [key]: value }));

  return (
    <section className="fx-invblock" aria-label="在庫">
      <h3>在庫（{props.productName}）</h3>
      <p className="fx-note">
        いまの残高: 預かり在庫 <b>{fmt(bal.deposit)}</b>個{bal.adjustStockManaged ? <> ／ 調整用在庫 <b>{fmt(bal.adjust)}</b>個</> : null}（{f.workDate} 時点）
      </p>
      <div className="fx-twocol">
        <div className="fx-field">
          <label htmlFor="f-boxCount">
            箱数<span className="fx-req">必須</span>
          </label>
          <input id="f-boxCount" type="number" inputMode="numeric" min={0} max={99999} value={f.boxCount} onChange={(e) => {
              boxTouched.current = true;
              set('boxCount', e.target.value);
            }} aria-describedby="h-boxCount e-boxCount" />
          <small id="h-boxCount">1箱 {fmt(bal.unitsPerBox)}個。目安 {fmt(eff.suggestedBoxes)}箱（処理数量÷入数）</small>
          <FieldError id="e-boxCount" issue={issueFor(props.issues, '/inventory/boxCount')} />
        </div>
        {bal.adjustStockManaged ? (
          <div className="fx-field">
            <label htmlFor="f-replenishBoxes">
              1箱回す（調整用在庫へ）<span className="fx-opt">任意</span>
            </label>
            <input id="f-replenishBoxes" type="number" inputMode="numeric" min={0} max={999} placeholder="0" value={f.replenishBoxes} onChange={(e) => set('replenishBoxes', e.target.value)} aria-describedby="h-replenishBoxes" />
            <small id="h-replenishBoxes">この検品分から調整用在庫に回す箱数（1箱＝{fmt(bal.unitsPerBox)}個）</small>
          </div>
        ) : null}
      </div>
      <div className="fx-twocol">
        <div className="fx-field">
          <label htmlFor="f-deliveredQuantity">
            納入数（個）<span className="fx-opt">任意</span>
          </label>
          <input id="f-deliveredQuantity" type="number" inputMode="numeric" min={0} max={9999999} placeholder="0" value={f.deliveredQuantity} onChange={(e) => set('deliveredQuantity', e.target.value)} aria-describedby="e-deliveredQuantity" />
          <FieldError id="e-deliveredQuantity" issue={issueFor(props.issues, '/inventory/deliveredQuantity')} />
        </div>
        <div className="fx-field">
          <label htmlFor="f-deliveredDate">納入日{dq > 0 ? <span className="fx-req">必須</span> : null}</label>
          <input id="f-deliveredDate" type="date" value={f.deliveredDate} onChange={(e) => set('deliveredDate', e.target.value)} aria-describedby="h-deliveredDate" />
          <small id="h-deliveredDate">納入は作業日と別の日でも登録できます（古い検査ロットから引き当てます）</small>
        </div>
      </div>
      <div className="fx-finalsummary" aria-live="polite">
        <div>
          <small>この日報での検品（良品）</small>
          <b>{fmt(eff.good)}個</b>
        </div>
        <div>
          <small>預かり在庫（確定後）</small>
          <b>{fmt(eff.depositAfter)}個</b>
        </div>
        {bal.adjustStockManaged ? (
          <div>
            <small>調整用在庫（確定後）</small>
            <b>{fmt(eff.adjustAfter)}個</b>
          </div>
        ) : null}
      </div>
      {eff.depositShort ? (
        <p className="fx-error" role="alert">
          預かり在庫が足りません（納入数が預かり在庫を超えています）。納入数または納入日を見直してください。
        </p>
      ) : null}
      {eff.adjustShort ? (
        <div className="fx-warnbox" role="alert">
          <p>調整用在庫が足りなくなります（確定後 {fmt(eff.adjustAfter)}個）。1箱回してください。そのまま記録する場合は確認にチェックしてください。</p>
          <label className="fx-confirmcheck" htmlFor="f-ackAdjust">
            <input id="f-ackAdjust" type="checkbox" checked={f.acknowledgeAdjustShort} onChange={(e) => set('acknowledgeAdjustShort', e.target.checked)} />
            調整用在庫が不足しても記録する
          </label>
          <FieldError id="e-ackAdjust" issue={issueFor(props.issues, '/inventory')} />
        </div>
      ) : eff.adjustLow ? (
        <p className="fx-note" role="status">調整用在庫が少なくなっています（確定後 {fmt(eff.adjustAfter)}個）。1箱回してください。</p>
      ) : null}
    </section>
  );
}
