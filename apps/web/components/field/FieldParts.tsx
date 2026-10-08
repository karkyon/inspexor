'use client';

/** 現場入力の共通部品: 状態バー・stepper・error summary・項目エラー */
import { useEffect, useRef, type ReactNode } from 'react';
import type { FieldIssue } from '@inspexor/domain';

export function StateBar({ online, lastSaved, storageOk, loadedAt }: { online: boolean; lastSaved: Date | null; storageOk: boolean; loadedAt: Date | null }) {
  const hhmm = (d: Date) => d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
  return (
    <>
      {!online ? (
        <div className="fx-offline-banner" role="status" aria-live="polite">
          オフラインです。入力は端末に下書き保存されます。確定は通信が戻るまでできません。
          {loadedAt !== null ? `（マスタ最終取得 ${hhmm(loadedAt)}）` : ''}
        </div>
      ) : null}
      <div className="fx-statebar">
        <span className={online ? 'fx-online' : ''}>{online ? '● オンライン' : '○ オフライン'}</span>
        <span>{lastSaved !== null ? `最終保存 ${hhmm(lastSaved)}` : '未保存'}</span>
        <span>{storageOk ? '端末下書き 有効' : '端末下書き 保存できません'}</span>
      </div>
    </>
  );
}

export function Stepper({ steps, current, label }: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol className="fx-stepper" aria-label={`${label}の進行状況`}>
      {steps.map((s, i) => {
        const n = i + 1;
        const cls = n < current ? 'done' : n === current ? 'on' : '';
        return (
          <li key={s} className={`fx-step ${cls}`} aria-current={n === current ? 'step' : undefined}>
            <i aria-hidden="true">{n < current ? '✓' : n}</i>
            <span>{s}</span>
            <span className="fx-visually-hidden">{n < current ? '（完了）' : n === current ? '（入力中）' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 入力エラーの一覧。表示時に focus（画面外部仕様: 先頭 error summary へ focus） */
export function ErrorSummary({ issues, hrefOf, extra }: { issues: readonly FieldIssue[]; hrefOf: (path: string) => string | null; extra?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (issues.length > 0) ref.current?.focus();
  }, [issues]);
  if (issues.length === 0) return null;
  return (
    <div className="fx-errorsummary" role="alert" tabIndex={-1} ref={ref} aria-labelledby="fx-error-title">
      <b id="fx-error-title">入力内容を確認してください</b>
      <ul>
        {issues.map((i) => {
          const href = hrefOf(i.path);
          return <li key={`${i.path}-${i.code}`}>{href !== null ? <a href={href}>{i.message}</a> : i.message}</li>;
        })}
      </ul>
      {extra}
    </div>
  );
}

export function issueFor(issues: readonly FieldIssue[], ...paths: string[]): FieldIssue | undefined {
  return issues.find((i) => paths.some((p) => i.path === p || i.path.startsWith(`${p}/`)));
}

export function FieldError({ id, issue }: { id: string; issue: FieldIssue | undefined }) {
  if (issue === undefined) return null;
  return (
    <small id={id} className="fx-fielderror">
      {issue.message}
    </small>
  );
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? `confirm-${crypto.randomUUID()}` : `confirm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
