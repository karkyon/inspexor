'use client';

/**
 * 日報PDFのプレビュー・ダウンロード（提案書 SK-2026-08-MINI P.5「日報PDFプレビュー・出力」/ CHG-004）。
 *   実績の詳細（API-005/009）で帳票の状態を確認 → 作成済なら API-024 で10分の署名付き URL を取得し、
 *   「プレビュー」（ブラウザ内表示。iPad は共有ボタンからメールに添付）と「ダウンロード」を出す。
 *   auto=true は確定直後の画面用で、作成されるまで2秒ごとに最大2分待つ。期限切れは押した時に取り直す。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { apiRequest } from '../../lib/api/client';

type ReportType = 'WORK' | 'DELIVERY';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'ready'; readonly url: string; readonly expiresAt: number }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly message: string };

const POLL_MS = 2000;
const WAIT_LIMIT_MS = 120_000;
const EXPIRY_MARGIN_MS = 30_000;

export function pdfLabel(type: ReportType): string {
  return type === 'WORK' ? '日報PDF' : '運搬報告PDF';
}

export type Fetched = { kind: 'ready'; url: string; expiresAt: number } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'error'; message: string };

export async function fetchPdf(type: ReportType, id: string): Promise<Fetched> {
  const detail = await apiRequest<{ documentStatus: string | null; documentId: string | null }>('GET', `/${type === 'WORK' ? 'work-reports' : 'delivery-reports'}/${id}`);
  if (!detail.ok) return { kind: 'error', message: detail.error.message };
  const { documentStatus, documentId } = detail.data;
  if (documentStatus === 'FAILED_FINAL') return { kind: 'failed' };
  if (documentStatus !== 'GENERATED' || documentId === null) return { kind: 'pending' };
  const doc = await apiRequest<{ signedUrl: string | null; signedUrlExpiresAt: string | null }>('GET', `/documents/${documentId}`);
  if (!doc.ok) return { kind: 'error', message: doc.error.message };
  if (doc.data.signedUrl === null || doc.data.signedUrlExpiresAt === null) return { kind: 'pending' };
  return { kind: 'ready', url: doc.data.signedUrl, expiresAt: Date.parse(doc.data.signedUrlExpiresAt) };
}

export function inlineUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}disposition=inline`;
}

export function PdfLinks({ type, id, auto = false }: { type: ReportType; id: string; auto?: boolean }) {
  const [state, setState] = useState<State>({ kind: auto ? 'waiting' : 'idle' });
  const alive = useRef(true);
  const label = pdfLabel(type);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (wait: boolean) => {
      const started = Date.now();
      setState({ kind: wait ? 'waiting' : 'loading' });
      for (;;) {
        const r = await fetchPdf(type, id);
        if (!alive.current) return;
        if (r.kind === 'ready') return setState(r);
        if (r.kind === 'failed') return setState({ kind: 'failed' });
        if (r.kind === 'error') return setState({ kind: 'error', message: r.message });
        if (Date.now() - started >= (wait ? WAIT_LIMIT_MS : 0)) return setState({ kind: wait ? 'timeout' : 'waiting' });
        setState({ kind: 'waiting' });
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!alive.current) return;
      }
    },
    [type, id],
  );

  useEffect(() => {
    if (auto) void load(true);
  }, [auto, load]);

  /** 署名付き URL の期限（10分）が近ければ取り直してから開く */
  const openFresh = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>, inline: boolean) => {
      if (state.kind !== 'ready' || Date.now() < state.expiresAt - EXPIRY_MARGIN_MS) return;
      event.preventDefault();
      const r = await fetchPdf(type, id);
      if (r.kind !== 'ready') return void load(false);
      setState(r);
      window.location.assign(inline ? inlineUrl(r.url) : r.url);
    },
    [state, type, id, load],
  );

  if (state.kind === 'ready') {
    return (
      <div className="fx-pdf" role="group" aria-label={label}>
        <a className="fx-btn primary" href={inlineUrl(state.url)} target="_blank" rel="noopener" onClick={(e) => void openFresh(e, true)}>
          {label}をプレビュー
        </a>
        <a className="fx-btn" href={state.url} onClick={(e) => void openFresh(e, false)}>
          {label}をダウンロード
        </a>
        <small className="fx-muted">iPad はプレビュー画面の共有ボタンからメールに添付できます。</small>
      </div>
    );
  }
  if (state.kind === 'waiting' || state.kind === 'loading') {
    return (
      <p className="fx-pdf-note" aria-live="polite" aria-busy="true">
        {state.kind === 'loading' ? `${label}を確認しています…` : `${label}を作成しています…`}
        {!auto && state.kind === 'waiting' ? (
          <button type="button" className="fx-linkbtn" onClick={() => void load(false)}>
            もう一度確認
          </button>
        ) : null}
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="fx-pdf-note" role="alert">
        {label}を作成できませんでした。事務所に連絡してください。
      </p>
    );
  }
  if (state.kind === 'timeout' || state.kind === 'error') {
    return (
      <p className="fx-pdf-note" role="alert">
        {state.kind === 'error' ? state.message : `${label}の作成に時間がかかっています。`}
        <button type="button" className="fx-linkbtn" onClick={() => void load(false)}>
          もう一度確認
        </button>
      </p>
    );
  }
  return (
    <button type="button" className="fx-linkbtn" onClick={() => void load(false)}>
      {label}を表示
    </button>
  );
}
