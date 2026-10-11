/**
 * worker の外部依存 port（開発スタック定義書 §6: provider は port/adapter 化し fixture adapter も同じ契約で試験）。
 * Gmail adapter は G9（日報メールは CHG-004 で既定無効）。
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    /** network/408/429/5xx 相当なら true（retry 対象） */
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
  }
}

/** 保存先は @inspexor/docstore の StorageAdapter（Cloud Storage / ローカル）を使う（CHG-006） */
export type { StorageAdapter, StoredObject } from '@inspexor/docstore';

export interface PdfRenderer {
  /** 完成済み HTML（placeholder 置換済み）→ PDF bytes */
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface MailMessage {
  /** 冪等性の鍵（mail_jobs.idempotency_key 由来）。provider 側の重複検出に使う */
  readonly messageId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly MailAttachment[];
}

export interface MailSender {
  /** 既に同じ messageId で送信済みなら provider の id を返す（timeout 後の再試行で二重送信しないため） */
  findSent(messageId: string): Promise<string | null>;
  send(message: MailMessage): Promise<string>;
}
