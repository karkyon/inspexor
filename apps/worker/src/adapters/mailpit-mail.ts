/**
 * 開発用 mail adapter（EXT-03 Gmail OAuth 未提供時の代替、MVP開発計画 §外部入力）。Mailpit の HTTP API で送信する。
 * Message-ID を mail job の冪等 key から作り、再試行前に Mailpit を検索して二重送信を防ぐ（T-MAIL-001）。
 */
import { AdapterError, type MailMessage, type MailSender } from '../ports';

export class MailpitMailSender implements MailSender {
  constructor(
    private readonly baseUrl: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new AdapterError(`mailpit unreachable: ${String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    }
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new AdapterError(`mailpit http ${res.status}`, retryable, retryable ? 'DEPENDENCY_UNAVAILABLE' : 'MAIL_REJECTED');
    }
    return res.json();
  }

  async findSent(messageId: string): Promise<string | null> {
    const id = messageId.replace(/^<|>$/g, '');
    const json = (await this.call(`/api/v1/search?query=${encodeURIComponent(`message-id:"${id}"`)}`)) as { messages?: Array<{ ID: string; MessageID: string }> };
    const hit = (json.messages ?? []).find((m) => m.MessageID === id);
    return hit?.ID ?? null;
  }

  async send(message: MailMessage): Promise<string> {
    const body = {
      From: { Email: this.from, Name: 'INSPEXOR' },
      To: message.to.map((Email) => ({ Email })),
      Cc: message.cc.map((Email) => ({ Email })),
      Bcc: message.bcc,
      Subject: message.subject,
      Text: message.text,
      Headers: { 'Message-ID': message.messageId },
      Attachments: message.attachments.map((a) => ({ Filename: a.filename, ContentType: a.contentType, Content: a.bytes.toString('base64') })),
    };
    const json = (await this.call('/api/v1/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })) as { ID?: string };
    if (typeof json.ID !== 'string') throw new AdapterError('mailpit returned no id', true, 'DEPENDENCY_UNAVAILABLE');
    return json.ID;
  }
}
