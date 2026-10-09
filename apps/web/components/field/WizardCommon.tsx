'use client';

import type { ApiError } from '../../lib/api/client';
import { useFieldUser } from './FieldShell';
import { PdfLinks } from './PdfLinks';
import type { Done } from './useWizard';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '下書き',
  CONFIRMED: '確定',
  SUBMITTED: '提出済',
  APPROVED: '承認済',
  REJECTED: '差戻し',
  REVOKED: '取消',
  BILLING_LOCKED: '請求確定済',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** 409（競合・状態）と通信/サーバーエラーの表示。項目エラー（422）は ErrorSummary 側 */
export function ConflictBanner({ error, onReload, onDiscard }: { error: ApiError | null; onReload: () => void; onDiscard: () => void }) {
  if (error === null || error.code === 'VALIDATION_ERROR') return null;
  if (error.code === 'VERSION_CONFLICT') {
    return (
      <div className="fx-conflict" role="alert">
        <b>他の利用者により更新されています（最新 version {error.currentVersion ?? '?'}）。</b>
        <p>
          変更された項目: {(error.changedFields ?? []).map((p) => p.replace('/', '')).join('、') || '不明'}。この画面の内容はまだ保存されていません。
        </p>
        <button type="button" className="fx-btn" onClick={onReload}>
          最新の内容を読み込む
        </button>
      </div>
    );
  }
  if (error.code === 'STATE_CONFLICT') {
    return (
      <div className="fx-conflict" role="alert">
        <b>この報告は既に確定済みのため変更できません。</b>
        <p>端末の下書きを破棄して、新しく登録してください。</p>
        <button type="button" className="fx-btn" onClick={onReload}>
          状態を確認する
        </button>{' '}
        <button type="button" className="fx-btn" onClick={onDiscard}>
          下書きを破棄
        </button>
      </div>
    );
  }
  return (
    <div className="fx-conflict" role="alert">
      <b>{error.message}</b>
      <p>入力内容は端末に保存されています。時間をおいて再度「確定」を押してください。</p>
    </div>
  );
}

export function DonePanel({ kind, type, done, again }: { kind: string; type: 'WORK' | 'DELIVERY'; done: Done; again: string }) {
  const user = useFieldUser();
  const office = user.roles.includes('OFFICE');
  return (
    <section className="fx-done" role="status" aria-live="polite">
      <h1>{kind}を登録しました</h1>
      <p>
        報告番号 <b>{done.reportNo}</b>（状態: {statusLabel(done.status)}）。帳票PDFは自動で作成され、作成後に「提出済」になります。
      </p>
      <PdfLinks type={type} id={done.id} auto />
      <div className="fx-actions" style={{ position: 'static', background: 'transparent', border: 0, padding: 0 }}>
        <a className="fx-btn" href="/field">
          現場ホームへ
        </a>
        {office ? (
          <a className="fx-btn" href={`/admin/records/${type === 'WORK' ? 'work' : 'delivery'}/${done.id}`}>
            事務所の詳細画面へ
          </a>
        ) : null}
        <a className="fx-btn primary" href={`${again}?step=1`}>
          続けて登録する
        </a>
      </div>
    </section>
  );
}

export function NotAllowed() {
  return (
    <section className="fx-card" role="alert" style={{ padding: 24 }}>
      <h1>このロールでは実績を登録できません</h1>
      <p>運搬・作業の登録は現場（FIELD）・事務（OFFICE）ロールで行えます。</p>
      <a href="/field">現場ホームへ戻る</a>
    </section>
  );
}
