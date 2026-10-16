'use client';

/**
 * wizard 共通: 端末下書き（sessionStorage 自動保存）、URL の step、server 保存（POST/PATCH）→ confirm（Idempotency-Key）。
 *  - EV-EDIT: 値変更から1秒以内に下書き保存（仕様 5秒以内）。保存失敗は警告表示
 *  - EV-SUBMIT: client 検証＋online のときだけ server command。成功後にのみ完了表示
 *  - 409 VERSION_CONFLICT: 自動上書きせず、server の内容を読み込む操作を提示
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toJstParts, type FieldIssue } from '@inspexor/domain';
import { apiRequest, type ApiError } from '../../lib/api/client';
import { clearDraft, loadDraft, saveDraft, type DraftType } from '../../lib/field/draft-store';
import { stepOfPath } from '../../lib/field/wizard';
import { newIdempotencyKey } from './FieldParts';

export interface ServerState {
  readonly id: string | null;
  readonly version: number | null;
  readonly reportNo: string | null;
}

export interface Done {
  readonly id: string;
  readonly reportNo: string;
  readonly status: string;
}

export function todayJst(): string {
  return toJstParts(new Date()).date;
}

/** CHG-012: 代理入力の理由は作成（POST）だけ。更新（PATCH）では送らない */
const withoutProxy = (b: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'proxyReason'));

export function useWizard<F>(options: {
  type: DraftType;
  userId: string;
  basePath: string;
  maxStep: number;
  initial: () => F;
  /** 指定 step を表示してよいか（それ以前の step の検証が通るか） */
  firstInvalidStep: (form: F) => number | null;
  apiSegment: 'work-reports' | 'delivery-reports';
  detailToForm: (detail: Record<string, unknown>) => F;
  /** 古い端末下書き（項目追加前）を現在の形に補う（CHG-004） */
  normalize?: (form: F) => F;
}) {
  const { type, userId, basePath, maxStep, apiSegment } = options;
  const params = useSearchParams();
  const requested = Math.min(Math.max(Number(params.get('step') ?? '1') || 1, 1), maxStep);

  const [loaded, setLoaded] = useState(false);
  const [form, setFormState] = useState<F>(options.initial);
  const [server, setServer] = useState<ServerState>({ id: null, version: null, reportNo: null });
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState<FieldIssue[]>([]);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ form, server, step: requested });
  latest.current = { form, server, step: requested };

  // 初回: 端末下書きを復元
  useEffect(() => {
    const draft = loadDraft<F>(userId, type);
    if (draft !== null) {
      setFormState(options.normalize !== undefined ? options.normalize(draft.data) : draft.data);
      setServer({ id: draft.serverId, version: draft.serverVersion, reportNo: draft.reportNo });
      setLastSaved(new Date(draft.updatedAt));
    }
    setLoaded(true);
  }, [userId, type]);

  const persist = useCallback(
    (f: F, s: ServerState, step: number) => {
      const ok = saveDraft<F>(userId, type, { step, data: f, serverId: s.id, serverVersion: s.version, reportNo: s.reportNo });
      setStorageOk(ok);
      if (ok) setLastSaved(new Date());
    },
    [userId, type],
  );

  /** B-06: 自動保存の予約を取り消す（確定・破棄の後に下書きを保存し直さない） */
  const cancelAutosave = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const setForm = useCallback(
    (updater: (prev: F) => F) => {
      setFormState((prev) => {
        const next = updater(prev);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => persist(next, latest.current.server, latest.current.step), 1000);
        return next;
      });
    },
    [persist],
  );

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // 未入力の step を飛ばして開いた場合は、最初の未完了 step へ戻す
  const firstInvalid = loaded ? options.firstInvalidStep(form) : null;
  const step = firstInvalid !== null && firstInvalid < requested ? firstInvalid : requested;
  useEffect(() => {
    if (loaded && step !== requested) window.history.replaceState(null, '', `${basePath}?step=${step}`);
  }, [loaded, step, requested, basePath]);

  const goStep = useCallback(
    (n: number) => {
      persist(latest.current.form, latest.current.server, n);
      setServerIssues([]);
      setApiError(null);
      // step 移動は client 内の履歴操作のみ（サーバー往復なし＝オフラインでも進める: REQ-OFF-001）
      window.history.pushState(null, '', `${basePath}?step=${n}`);
      window.scrollTo(0, 0);
    },
    [persist, basePath],
  );

  /** 最終 step: server に保存（POST or PATCH）→ confirm */
  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setServerIssues([]);
      setApiError(null);
      try {
        let s = latest.current.server;
        const saved =
          s.id === null
            ? await apiRequest<{ id: string; version: number; reportNo: string }>('POST', `/${apiSegment}`, body)
            : await apiRequest<{ id: string; version: number; reportNo: string }>('PATCH', `/${apiSegment}/${s.id}`, { ...withoutProxy(body), expectedVersion: s.version });
        if (!saved.ok) {
          setApiError(saved.error);
          setServerIssues([...(saved.error.fields ?? [])]);
          return;
        }
        s = { id: saved.data.id, version: saved.data.version, reportNo: saved.data.reportNo };
        setServer(s);
        persist(latest.current.form, s, latest.current.step);
        const confirmed = await apiRequest<{ reportNo: string; status: string; version: number }>(
          'POST',
          `/${apiSegment}/${s.id}/confirm`,
          { expectedVersion: s.version },
          { 'Idempotency-Key': newIdempotencyKey() },
        );
        if (!confirmed.ok) {
          setApiError(confirmed.error);
          setServerIssues([...(confirmed.error.fields ?? [])]);
          return;
        }
        cancelAutosave();
        clearDraft(userId, type);
        setDone({ id: s.id ?? saved.data.id, reportNo: confirmed.data.reportNo, status: confirmed.data.status });
      } finally {
        setBusy(false);
      }
    },
    [apiSegment, persist, userId, type, cancelAutosave],
  );

  /** 409 時: server の最新内容で置き換える（自動上書きはしない＝利用者の操作で実行） */
  const reloadFromServer = useCallback(async () => {
    const id = latest.current.server.id;
    if (id === null) return;
    const res = await apiRequest<Record<string, unknown>>('GET', `/${apiSegment}/${id}`);
    if (!res.ok) {
      setApiError(res.error);
      return;
    }
    if (res.data['status'] !== 'DRAFT') {
      cancelAutosave();
      clearDraft(userId, type);
      setDone({ id, reportNo: String(res.data['reportNo']), status: String(res.data['status']) });
      return;
    }
    const f = options.detailToForm(res.data);
    const s = { id, version: Number(res.data['version']), reportNo: String(res.data['reportNo']) };
    cancelAutosave();
    setFormState(f);
    setServer(s);
    setApiError(null);
    setServerIssues([]);
    persist(f, s, latest.current.step);
  }, [apiSegment, options, persist, userId, type, cancelAutosave]);

  const discard = useCallback(() => {
    cancelAutosave();
    clearDraft(userId, type);
    setFormState(options.initial());
    setServer({ id: null, version: null, reportNo: null });
    setLastSaved(null);
    window.history.pushState(null, '', `${basePath}?step=1`);
  }, [userId, type, options, basePath, cancelAutosave]);

  return {
    loaded,
    form,
    setForm,
    step,
    goStep,
    server,
    lastSaved,
    storageOk,
    busy,
    serverIssues,
    apiError,
    submit,
    reloadFromServer,
    discard,
    done,
    stepOfIssue: (path: string) => stepOfPath(type, path),
  };
}
