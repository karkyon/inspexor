'use client';

/**
 * SCR-13 マスター管理: 追加・編集・無効化（API-015/016/017/018）。
 *  - 項目は MASTER_DEFS（CHG-001 / openapi）から生成。サーバー確定後にだけ成功表示（画面外部仕様 共通）
 *  - 入力エラー: 先頭の error summary へ focus、各項目は aria-describedby で詳細表示
 *  - 競合(409): 自動上書きせず、changedFields を示して再読込
 *  - 遡及: 「影響を確認」（?preview=true）で件数を表示、無効化は確認ダイアログで影響→理由→実行
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, type ApiError } from '../../lib/api/client';
import { MASTER_DEFS, type FieldDef, type MasterType } from '../../lib/masters/definitions';
import {
  ENUM_LABELS,
  NAV_LABEL,
  emptyFormState,
  fieldLabel,
  formStateToPayload,
  parentLookupOf,
  recordToFormState,
  type FormState,
  type LookupEntry,
} from '../../lib/masters/ui';
import { canEditMasters, useAdminUser } from './AdminShell';
import { useLookups } from './useLookups';

type MasterRecord = Record<string, unknown> & { id: string; version: number; active: boolean; updatedAt: string };

interface Impact {
  readonly retroactive: boolean;
  readonly affectedRecordCount: number;
  readonly affectedOpenBillingRunCount: number;
  readonly referencedBy: readonly string[];
}

const REF_LABELS: Record<string, string> = {
  products: '有効な品番',
  contacts: '有効な連絡先',
  billingRuns: '請求run',
  workTypes: '有効な作業内容',
  defects: '有効な不良種別',
  rates: '有効な単価ルール',
  workRevisions: '作業実績',
  defectResults: '不良実績',
  productLinks: '担当品番の設定',
};

function ImpactView({ impact }: { readonly impact: Impact }) {
  return (
    <div className={`ix-impact${impact.retroactive ? ' warn' : ''}`} role="status" aria-live="polite">
      <b>{impact.retroactive ? '⚠ 過去の期間に影響する変更です（理由の入力が必要）' : '過去の期間には影響しません'}</b>
      <ul>
        <li>影響する未請求の実績: {impact.affectedRecordCount}件</li>
        <li>影響する未確定の請求計算: {impact.affectedOpenBillingRunCount}件</li>
        <li>確定済みの請求書は変更されません</li>
        {impact.referencedBy.map((r) => {
          const [key, n] = r.split(':');
          return (
            <li key={r}>
              参照中: {REF_LABELS[key ?? ''] ?? key} {n}件
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function fieldErrorMap(error: ApiError | null): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of error?.fields ?? []) {
    const key = f.path.split('/')[1] ?? '';
    if (key !== '' && map[key] === undefined) map[key] = f.message;
  }
  return map;
}

export function MasterEditor({ type, id }: { readonly type: MasterType; readonly id: string }) {
  const router = useRouter();
  const user = useAdminUser();
  const editable = canEditMasters(user);
  const def = MASTER_DEFS[type];
  const isNew = id === 'new';
  const { lookups } = useLookups();
  const [record, setRecord] = useState<MasterRecord | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyFormState(def));
  const [reason, setReason] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ impact: Impact | null; reason: string; error: ApiError | null } | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  async function load(): Promise<void> {
    if (isNew) return;
    const res = await apiRequest<MasterRecord>('GET', `/masters/${type}/${id}`);
    if (res.ok) {
      setRecord(res.data);
      setForm(recordToFormState(def, res.data));
      setError(null);
      setImpact(null);
    } else {
      setLoadError(res.error.message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  useEffect(() => {
    if (error !== null && error.code !== 'VERSION_CONFLICT') summaryRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    if (dialog !== null && !el.open) el.showModal?.();
    if (dialog === null && el.open) el.close();
  }, [dialog]);

  const errors = fieldErrorMap(error);
  const readOnly = !editable;

  function set(api: string, value: string | boolean | string[]): void {
    setForm((prev) => ({ ...prev, [api]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const payload = formStateToPayload(def, form);
    const res = isNew
      ? await apiRequest<MasterRecord>('POST', `/masters/${type}`, payload)
      : await apiRequest<MasterRecord>('PATCH', `/masters/${type}/${id}`, { ...payload, expectedVersion: record?.version, reason });
    setBusy(false);
    if (res.ok) {
      router.push(`/admin/masters/${type}?saved=${isNew ? 'created' : 'updated'}`);
    } else {
      setError(res.error);
    }
  }

  async function preview(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await apiRequest<Impact>('PATCH', `/masters/${type}/${id}?preview=true`, {
      ...formStateToPayload(def, form),
      expectedVersion: record?.version,
      reason: reason.trim() === '' ? '（影響確認）' : reason,
    });
    setBusy(false);
    if (res.ok) setImpact(res.data);
    else setError(res.error);
  }

  async function openDeactivate(): Promise<void> {
    setDialog({ impact: null, reason: '', error: null });
    const res = await apiRequest<Impact>('DELETE', `/masters/${type}/${id}?preview=true`, { expectedVersion: record?.version });
    setDialog((d) => (d === null ? d : res.ok ? { ...d, impact: res.data } : { ...d, error: res.error }));
  }

  async function confirmDeactivate(): Promise<void> {
    if (dialog === null) return;
    setBusy(true);
    const res = await apiRequest('DELETE', `/masters/${type}/${id}`, {
      expectedVersion: record?.version,
      ...(dialog.reason.trim() !== '' ? { reason: dialog.reason } : {}),
    });
    setBusy(false);
    if (res.ok) {
      setDialog(null);
      router.push(`/admin/masters/${type}?saved=deactivated`);
    } else {
      setDialog({ ...dialog, error: res.error });
    }
  }

  function optionsFor(f: FieldDef): LookupEntry[] {
    const key = parentLookupOf(f.api);
    if (key === undefined) return [];
    const all = [...lookups[key].values()];
    if (f.api === 'workTypeId') return all.filter((w) => w.productId === form['productId']);
    return all.sort((a, b) => a.code.localeCompare(b.code));
  }

  function renderField(f: FieldDef) {
    const htmlId = `f-${f.api}`;
    const errId = `${htmlId}-err`;
    const label = fieldLabel(type, f.api);
    const value = form[f.api];
    const invalid = errors[f.api] !== undefined;
    const common = {
      id: htmlId,
      'aria-invalid': invalid || undefined,
      'aria-describedby': invalid ? errId : undefined,
      disabled: readOnly || (!isNew && f.kind === 'uuid' && f.parent !== undefined),
    };
    let input;
    if (f.kind === 'bool') {
      input = <input type="checkbox" {...common} checked={value === true} onChange={(e) => set(f.api, e.target.checked)} />;
    } else if (f.kind === 'enum') {
      input = (
        <select {...common} value={String(value)} onChange={(e) => set(f.api, e.target.value)}>
          <option value="">選択してください</option>
          {(f.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {ENUM_LABELS[f.api]?.[v] ?? v}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === 'uuid' || f.kind === 'uuidNullable') {
      input = (
        <select {...common} value={String(value)} onChange={(e) => set(f.api, e.target.value)}>
          <option value="">{f.kind === 'uuidNullable' ? (f.api === 'workTypeId' ? '全作業（指定なし）' : '指定なし') : '選択してください'}</option>
          {optionsFor(f).map((o) => (
            <option key={o.id} value={o.id} disabled={!o.active && o.id !== value}>
              {o.code} {o.name}
              {o.active ? '' : '（無効）'}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === 'uuidArray') {
      const products = [...lookups.products.values()].filter((p) => p.customerId === form['customerId'] && p.active);
      const selected = Array.isArray(value) ? value : [];
      input = (
        <fieldset {...common} className="ix-checklist">
          <legend className="ix-visually-hidden">{label}</legend>
          {form['customerId'] === '' ? <small className="ix-muted">先にお客様を選択してください。</small> : null}
          {products.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={selected.includes(p.id)}
                onChange={(e) => set(f.api, e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
              />
              {p.code} {p.name}
            </label>
          ))}
        </fieldset>
      );
    } else {
      const inputType = f.kind === 'date' || f.kind === 'dateNullable' ? 'date' : f.kind === 'email' ? 'email' : f.kind === 'int' || f.kind === 'yen' ? 'number' : 'text';
      input = (
        <input
          {...common}
          type={inputType}
          inputMode={f.kind === 'decimal14_4' || f.kind === 'decimal4_4' ? 'decimal' : f.kind === 'int' || f.kind === 'yen' ? 'numeric' : undefined}
          maxLength={f.max}
          required={f.required}
          value={String(value)}
          onChange={(e) => set(f.api, e.target.value)}
        />
      );
    }
    return (
      <div key={f.api} className={`ix-field${f.kind === 'bool' ? ' check' : ''}`}>
        <label htmlFor={htmlId}>
          {label}
          {f.required ? <span className="ix-req">必須</span> : null}
        </label>
        {input}
        {!isNew && f.kind === 'uuid' && f.parent !== undefined ? <small className="ix-muted">登録後は変更できません。</small> : null}
        {invalid ? (
          <small id={errId} className="ix-fielderror">
            {errors[f.api]}
          </small>
        ) : null}
      </div>
    );
  }

  const label = NAV_LABEL[type];
  if (loadError !== null) {
    return (
      <section className="ix-panel" role="alert">
        <h1>{label}</h1>
        <p>{loadError}</p>
        <a href={`/admin/masters/${type}`}>一覧へ戻る</a>
      </section>
    );
  }
  if (!isNew && record === null) {
    return <p className="ix-muted" aria-live="polite">読み込み中…</p>;
  }
  if (isNew && !editable) {
    return (
      <section className="ix-panel" role="alert">
        <p>追加は管理者のみ行えます。</p>
        <a href={`/admin/masters/${type}`}>一覧へ戻る</a>
      </section>
    );
  }

  const conflict = error?.code === 'VERSION_CONFLICT' ? error : null;
  const summaryItems = conflict === null && error !== null ? (error.fields?.length ? error.fields : [{ path: '/', code: error.code, message: error.message }]) : [];

  return (
    <div className="ix-page ix-editor">
      <div className="ix-pagehead">
        <div>
          <small>
            <a href={`/admin/masters/${type}`}>マスター管理 / {label}</a>
          </small>
          <h1>
            {isNew ? `${label}を追加` : `${label}の${editable ? '編集' : '詳細'}`}{' '}
            {record !== null ? <span className={`ix-pill ${record.active ? 'approved' : 'draft'}`}>{record.active ? '有効' : '無効'}</span> : null}
          </h1>
          {record !== null ? <p>version {record.version}・最終更新 {new Date(record.updatedAt).toLocaleString('ja-JP')}</p> : null}
        </div>
      </div>

      {conflict !== null ? (
        <div className="ix-conflict" role="alert">
          <b>他の利用者により更新されています（最新 version {conflict.currentVersion}）。</b>
          <p>
            変更された項目: {(conflict.changedFields ?? []).map((p) => fieldLabel(type, p.replace('/', ''))).join('、') || '不明'}。入力内容は保存されていません。
          </p>
          <button type="button" className="ix-btn" onClick={() => void load()}>
            最新の内容を読み込む
          </button>
        </div>
      ) : null}

      {summaryItems.length > 0 ? (
        <div className="ix-errorsummary" role="alert" tabIndex={-1} ref={summaryRef} aria-labelledby="error-summary-title">
          <b id="error-summary-title">入力内容を確認してください</b>
          <ul>
            {summaryItems.map((f) => {
              const key = f.path.split('/')[1] ?? '';
              return (
                <li key={`${f.path}-${f.code}`}>
                  {key !== '' && def.fields.some((d) => d.api === key) ? <a href={`#f-${key}`}>{fieldLabel(type, key)}: {f.message}</a> : f.message}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <form className="ix-panel ix-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="ix-formgrid">{def.fields.map(renderField)}</div>
        {!isNew && editable ? (
          <div className={`ix-field${errors['reason'] !== undefined ? ' has-error' : ''}`}>
            <label htmlFor="f-reason">
              変更理由<span className="ix-req">必須</span>
            </label>
            <textarea id="f-reason" maxLength={1000} aria-invalid={errors['reason'] !== undefined || undefined} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={errors['reason'] !== undefined ? 'f-reason-err' : 'f-reason-help'} />
            <small id="f-reason-help" className="ix-muted">
              監査履歴に記録されます（1〜1000文字）。
            </small>
            {errors['reason'] !== undefined ? (
              <small id="f-reason-err" className="ix-fielderror">
                {errors['reason']}
              </small>
            ) : null}
          </div>
        ) : null}
        {impact !== null ? <ImpactView impact={impact} /> : null}
        {editable ? (
          <footer className="ix-actions">
            <a className="ix-btn" href={`/admin/masters/${type}`}>
              キャンセル
            </a>
            <div>
              {!isNew && def.retroactive !== 'NONE' ? (
                <button type="button" className="ix-btn" disabled={busy} onClick={() => void preview()}>
                  影響を確認
                </button>
              ) : null}
              {!isNew && record?.active ? (
                <button type="button" className="ix-btn danger" disabled={busy} onClick={() => void openDeactivate()}>
                  無効化
                </button>
              ) : null}
              <button type="submit" className="ix-btn primary" disabled={busy}>
                {busy ? '保存中…' : isNew ? '登録する' : '変更を保存'}
              </button>
            </div>
          </footer>
        ) : (
          <footer className="ix-actions">
            <a className="ix-btn" href={`/admin/masters/${type}`}>
              一覧へ戻る
            </a>
          </footer>
        )}
      </form>

      <dialog ref={dialogRef} className="ix-dialog" aria-labelledby="deactivate-title" onCancel={() => setDialog(null)}>
        {dialog !== null ? (
          <div>
            <h2 id="deactivate-title">{label}を無効化しますか？</h2>
            <p>削除はされず、新しい入力・請求計算の対象から外れます。過去の確定済みデータは変更されません。</p>
            {dialog.impact === null && dialog.error === null ? <p className="ix-muted">影響を確認しています…</p> : null}
            {dialog.impact !== null ? <ImpactView impact={dialog.impact} /> : null}
            {dialog.error !== null ? (
              <p role="alert" className="ix-error">
                {dialog.error.fields?.[0]?.message ?? dialog.error.message}
              </p>
            ) : null}
            <label htmlFor="deactivate-reason">
              理由{dialog.impact?.retroactive ? <span className="ix-req">必須</span> : '（任意）'}
            </label>
            <textarea id="deactivate-reason" maxLength={1000} value={dialog.reason} onChange={(e) => setDialog({ ...dialog, reason: e.target.value })} />
            <footer className="ix-actions">
              <button type="button" className="ix-btn" onClick={() => setDialog(null)}>
                やめる
              </button>
              <button
                type="button"
                className="ix-btn danger"
                disabled={busy || dialog.impact === null || (dialog.impact.retroactive && dialog.reason.trim() === '')}
                onClick={() => void confirmDeactivate()}
              >
                無効化する
              </button>
            </footer>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
