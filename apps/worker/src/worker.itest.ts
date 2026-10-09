/**
 * G4 統合試験（T-DOC-001〜 / T-MAIL-001〜 / REQ-DOC-001 / REQ-MAIL-001 / CHG-003）。
 * 実 PostgreSQL 16 の fresh DB（schema.sql＋migration）に、web の FieldReportService で実績を確定し、
 * worker の runOnce（dispatch → 帳票 → メール）を通しで検証する。PDF は実 Chromium と試験用 renderer の両方を使う。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jstToInstant } from '@inspexor/domain';
import { createFreshDatabase, insertUser, type FreshDatabase } from '../../web/lib/testing/fresh-db';
import { FieldReportService } from '../../web/lib/field/field-report-service';
import { ChromiumPdfRenderer } from './adapters/chromium-pdf';
import { LocalFsStorage } from './adapters/local-fs-storage';
import { MailpitMailSender } from './adapters/mailpit-mail';
import { dispatchOutbox } from './dispatcher';
import { AdapterError, type MailMessage, type MailSender, type PdfRenderer } from './ports';
import { runOnce, type WorkerDeps } from './worker';

const MAILPIT_URL = process.env['MAILPIT_URL'];
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
let db: FreshDatabase;
let storageDir: string;
let fieldUser: string;
const m: Record<string, string> = {};
let clock = new Date('2026-10-08T03:00:00.000Z');

class FakeRenderer implements PdfRenderer {
  calls = 0;
  failNext = 0;
  async render(html: string): Promise<Buffer> {
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new AdapterError('render timeout', true, 'DEPENDENCY_UNAVAILABLE');
    }
    return Buffer.from(`%PDF-1.7\n% test\n${createHash('sha256').update(html).digest('hex')}\n%%EOF`);
  }
  async close(): Promise<void> {}
}

class FakeSender implements MailSender {
  sent: Array<MailMessage & { id: string }> = [];
  /** true: provider には届いたが応答が timeout した状況（T-MAIL-001） */
  timeoutAfterSend = false;
  async findSent(messageId: string): Promise<string | null> {
    return this.sent.find((s) => s.messageId === messageId)?.id ?? null;
  }
  async send(message: MailMessage): Promise<string> {
    const id = `fake-${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    if (this.timeoutAfterSend) {
      this.timeoutAfterSend = false;
      throw new AdapterError('timeout', true, 'DEPENDENCY_UNAVAILABLE');
    }
    return id;
  }
}

async function one<T = { id: string }>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.pool.query(sql, params)).rows[0] as T;
}

function deps(renderer: PdfRenderer, sender: MailSender, templateDir?: string): WorkerDeps {
  return { pool: db.pool, storage: new LocalFsStorage(storageDir), pdf: renderer, sender, now: () => clock, dailyMailEnabled: true, ...(templateDir ? { templateDir } : {}) };
}

const ctx = () => ({ actor: { userId: fieldUser, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000001', now: clock });

async function confirmWork(productKey = 'pA'): Promise<{ id: string; reportNo: string }> {
  const svc = new FieldReportService(db.pool);
  const r = await svc.createWork(
    {
      workDate: '2026-10-08',
      reporterId: fieldUser,
      customerId: m['customer'] as string,
      productId: m[productKey] as string,
      workTypeId: m[`wt_${productKey}`] as string,
      lotNo: 'LOT-<A>&1',
      workerIds: [m['w1'] as string, m['w2'] as string],
      startAt: jstToInstant('2026-10-08', '13:00'),
      endAt: jstToInstant('2026-10-08', '18:00'),
      quantity: 1600,
      defects: [{ defectTypeId: m[`d_${productKey}`] as string, quantity: 12 }],
    },
    ctx(),
  );
  await svc.confirm('WORK', r.id, 1, ctx());
  return { id: r.id, reportNo: r.reportNo };
}

async function confirmDelivery(): Promise<{ id: string; reportNo: string }> {
  const svc = new FieldReportService(db.pool);
  const r = await svc.createDelivery(
    { deliveryDate: '2026-10-08', driverId: m['w1'] as string, customerId: m['customer'] as string, items: [{ productId: m['pA'] as string, quantity: 1200 }, { productId: m['pNoMail'] as string, quantity: 8 }] },
    ctx(),
  );
  await svc.confirm('DELIVERY', r.id, 1, ctx());
  return { id: r.id, reportNo: r.reportNo };
}

async function jobFor(reportId: string, table: 'work' | 'delivery') {
  return one<{ id: string; status: string; error_code: string | null; attempts: number; file_id: string | null; idempotency_key: string }>(
    `SELECT d.* FROM app.document_jobs d JOIN app.${table}_report_revisions r ON r.id = d.source_id WHERE r.report_id = $1 ORDER BY d.created_at DESC LIMIT 1`,
    [reportId],
  );
}

beforeAll(async () => {
  db = await createFreshDatabase('worker');
  storageDir = await mkdtemp(join(tmpdir(), 'inspexor-storage-'));
  fieldUser = await insertUser(db.pool, 'itest-field');
  await db.pool.query(`UPDATE app.users SET display_name = '現場 太郎' WHERE id = $1`, [fieldUser]);
  m['customer'] = (await one(`INSERT INTO app.customers(code,name,closing_day) VALUES ('C1','合成顧客＆<A>',31) RETURNING id`)).id;
  for (const key of ['pA', 'pNoMail']) {
    m[key] = (await one(`INSERT INTO app.products(customer_id,code,name,settlement_type) VALUES ($1,$2,$3,'QUANTITY') RETURNING id`, [m['customer'], key.toUpperCase(), `品${key}`])).id;
    m[`wt_${key}`] = (await one(`INSERT INTO app.work_types(product_id,code,name) VALUES ($1,'INSP','外観検査') RETURNING id`, [m[key]])).id;
    m[`d_${key}`] = (await one(`INSERT INTO app.defect_types(product_id,code,name,sort_order) VALUES ($1,'D1','バリ',1) RETURNING id`, [m[key]])).id;
  }
  m['w1'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W1','作業者 一郎') RETURNING id`)).id;
  m['w2'] = (await one(`INSERT INTO app.workers(code,name) VALUES ('W2','作業者 二郎') RETURNING id`)).id;
  const contact = (await one(`INSERT INTO app.customer_contacts(customer_id,code,name,email,send_daily) VALUES ($1,'K1','担当','tanto@example.com',true) RETURNING id`, [m['customer']])).id;
  await db.pool.query(`INSERT INTO app.product_contacts(product_id,contact_id,purpose) VALUES ($1,$2,'DAILY')`, [m['pA'], contact]);
  // pNoMail には DAILY 担当なし（宛先0件 → 帳票は作成、送信は FAILED_FINAL）
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('G4: 帳票 job（T-DOC-001 placeholder 残存は先に検査）', () => {
  it('未置換 placeholder を含む template は FAILED_FINAL（TEMPLATE_INVALID）、メール job なし、実績は CONFIRMED のまま', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inspexor-tpl-'));
    const html = await readFile(join(TEMPLATE_DIR, 'daily-report-v1.html'), 'utf8');
    await writeFile(join(dir, 'daily-report-v1.html'), html.replace('</body>', '<p>{{unknown_field}}</p></body>'));
    const r = await confirmWork();
    const renderer = new FakeRenderer();
    await runOnce(deps(renderer, new FakeSender(), dir));
    const job = await jobFor(r.id, 'work');
    expect(job).toMatchObject({ status: 'FAILED_FINAL', error_code: 'TEMPLATE_INVALID', file_id: null });
    expect(renderer.calls).toBe(0);
    expect(Number((await one<{ n: string }>('SELECT count(*) n FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).n)).toBe(0);
    expect((await one<{ status: string }>('SELECT status FROM app.work_reports WHERE id = $1', [r.id])).status).toBe('CONFIRMED');
    expect(Number((await one<{ n: string }>(`SELECT count(*) n FROM app.audit_events WHERE action='DOCUMENT_FAILED' AND target_id=$1`, [job.id])).n)).toBe(1);
    expect(Number((await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE event_type='DocumentFailed' AND aggregate_id=$1`, [job.id])).n)).toBe(1);
    // この試験で registry に登録された改変版を消す（以降は正規の template を使う）
    await db.pool.query(`DELETE FROM app.template_versions`);
  });
});

describe('CHG-004: 日報メール自動送信は既定で無効', () => {
  it('dailyMailEnabled 未指定なら 帳票は生成・SUBMITTED、mail job は作らず送信 0 通', async () => {
    const r = await confirmWork();
    const sender = new FakeSender();
    const { dailyMailEnabled: _on, ...rest } = deps(new FakeRenderer(), sender);
    const result = await runOnce(rest);
    expect(result.documents).toContain('generated');
    expect(result.mails).toEqual([]);
    const job = await jobFor(r.id, 'work');
    expect(job.status).toBe('GENERATED');
    expect((await one<{ status: string }>('SELECT status FROM app.work_reports WHERE id = $1', [r.id])).status).toBe('SUBMITTED');
    expect(Number((await one<{ n: string }>('SELECT count(*) n FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).n)).toBe(0);
    expect(sender.sent.length).toBe(0);
  });
});

describe('G4: 日報 生成 → 提出 → メール（正常系）', () => {
  it('確定 → dispatch → PDF 保存（hash 一致）→ files → GENERATED → SUBMITTED（version+1）→ 日報メール1通', async () => {
    const r = await confirmWork();
    const renderer = new FakeRenderer();
    const sender = new FakeSender();
    const result = await runOnce(deps(renderer, sender));
    expect(result.documents).toContain('generated');
    const job = await jobFor(r.id, 'work');
    expect(job.status).toBe('GENERATED');
    const file = await one<{ storage_key: string; sha256: string; size_bytes: string; mime_type: string; classification: string }>('SELECT * FROM app.files WHERE id = $1', [job.file_id]);
    expect(file.storage_key).toMatch(new RegExp(`^documents/DAILY_REPORT/${r.reportNo}/${job.id}/日報_2026-10-08_C1_${r.reportNo}_r1\\.pdf$`));
    const bytes = await readFile(join(storageDir, file.storage_key));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256.trim());
    expect(file).toMatchObject({ mime_type: 'application/pdf', classification: 'CONFIDENTIAL' });
    const header = await one<{ status: string; version: number }>('SELECT status, version FROM app.work_reports WHERE id = $1', [r.id]);
    expect(header).toEqual({ status: 'SUBMITTED', version: 3 });
    for (const t of ['DocumentGenerated', 'RecordSubmitted', 'MailSent']) {
      expect(Number((await one<{ n: string }>(`SELECT count(*) n FROM app.outbox_events WHERE event_type=$1`, [t])).n), t).toBeGreaterThanOrEqual(1);
    }
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0];
    expect(mail?.subject).toBe(`【INSPEXOR作業報告】2026-10-08 PA ${r.reportNo}`);
    expect(mail?.to).toEqual(['tanto@example.com']);
    expect(mail?.attachments.map((a) => a.filename)).toEqual([`日報_2026-10-08_C1_${r.reportNo}_r1.pdf`]);
    expect(mail?.text).toContain('自動送信');
    const mj = await one<{ status: string; provider_message_id: string; recipients: { to: string[] } }>('SELECT * FROM app.mail_jobs WHERE document_job_id = $1', [job.id]);
    expect(mj).toMatchObject({ status: 'SENT', provider_message_id: 'fake-1' });
    // audit には宛先アドレス・本文を残さない（SEC-017）
    const audit = await one<{ after_data: Record<string, unknown> }>(`SELECT after_data FROM app.audit_events WHERE action='MAIL_SENT' ORDER BY occurred_at DESC LIMIT 1`);
    expect(JSON.stringify(audit.after_data)).not.toContain('example.com');
  });

  it('同じ event の再配送でも job は1件（冪等 key）、生成済み job は再処理しない', async () => {
    const r = await confirmWork();
    await runOnce(deps(new FakeRenderer(), new FakeSender()));
    await db.pool.query(`UPDATE app.outbox_events SET status='PENDING' WHERE event_type='WorkReportConfirmed' AND aggregate_id=$1`, [r.id]);
    const renderer = new FakeRenderer();
    await dispatchOutbox(db.pool, clock);
    await runOnce(deps(renderer, new FakeSender()));
    const n = await one<{ n: string }>(`SELECT count(*) n FROM app.document_jobs d JOIN app.work_report_revisions r ON r.id=d.source_id WHERE r.report_id=$1`, [r.id]);
    expect(Number(n.n)).toBe(1);
    expect(renderer.calls).toBe(0);
  });

  it('宛先0件: 帳票は生成・提出、メールは FAILED_FINAL（RECIPIENT_EMPTY）', async () => {
    const r = await confirmWork('pNoMail');
    const sender = new FakeSender();
    await runOnce(deps(new FakeRenderer(), sender));
    const job = await jobFor(r.id, 'work');
    expect(job.status).toBe('GENERATED');
    expect((await one<{ status: string }>('SELECT status FROM app.work_reports WHERE id = $1', [r.id])).status).toBe('SUBMITTED');
    expect(await one('SELECT status, error_code FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).toEqual({ status: 'FAILED_FINAL', error_code: 'RECIPIENT_EMPTY' });
    expect(sender.sent).toHaveLength(0);
  });
});

describe('G4: 再試行（network/5xx のみ、10s/30s/…、最大5回）', () => {
  it('PDF 生成の一時障害 → FAILED_RETRYABLE、待機時間前は再取得しない、経過後に成功', async () => {
    const r = await confirmWork();
    const renderer = new FakeRenderer();
    renderer.failNext = 1;
    await runOnce(deps(renderer, new FakeSender()));
    expect(await jobFor(r.id, 'work')).toMatchObject({ status: 'FAILED_RETRYABLE', attempts: 1, error_code: 'DEPENDENCY_UNAVAILABLE' });
    clock = new Date(clock.getTime() + 5_000);
    await runOnce(deps(renderer, new FakeSender()));
    expect((await jobFor(r.id, 'work')).status).toBe('FAILED_RETRYABLE');
    clock = new Date(clock.getTime() + 6_000);
    await runOnce(deps(renderer, new FakeSender()));
    expect(await jobFor(r.id, 'work')).toMatchObject({ status: 'GENERATED', attempts: 2 });
  });

  it('5回 retry しても失敗なら FAILED_FINAL', async () => {
    const r = await confirmWork();
    const renderer = new FakeRenderer();
    renderer.failNext = 100;
    for (let i = 0; i < 6; i += 1) {
      await runOnce(deps(renderer, new FakeSender()));
      clock = new Date(clock.getTime() + 1_900_000);
    }
    expect(await jobFor(r.id, 'work')).toMatchObject({ status: 'FAILED_FINAL', attempts: 6 });
    expect((await one<{ status: string }>('SELECT status FROM app.work_reports WHERE id = $1', [r.id])).status).toBe('CONFIRMED');
  });

  it('T-MAIL-001: 送信後に timeout → 再試行時は provider を検索して重複送信 0', async () => {
    const r = await confirmWork();
    const sender = new FakeSender();
    sender.timeoutAfterSend = true;
    await runOnce(deps(new FakeRenderer(), sender));
    const job = await jobFor(r.id, 'work');
    expect(await one('SELECT status, attempts FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).toEqual({ status: 'FAILED_RETRYABLE', attempts: 1 });
    clock = new Date(clock.getTime() + 11_000);
    await runOnce(deps(new FakeRenderer(), sender));
    expect(await one('SELECT status, attempts, provider_message_id FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).toEqual({ status: 'SENT', attempts: 2, provider_message_id: 'fake-1' });
    expect(sender.sent).toHaveLength(1);
  });

  it('lease 切れの PROCESSING は再取得、lease 内は取得しない', async () => {
    const r = await confirmWork();
    await dispatchOutbox(db.pool, clock);
    const job = await jobFor(r.id, 'work');
    await db.pool.query(`UPDATE app.document_jobs SET status='PROCESSING', updated_at=$2 WHERE id=$1`, [job.id, new Date(clock.getTime() - 60_000).toISOString()]);
    await runOnce(deps(new FakeRenderer(), new FakeSender()));
    expect((await jobFor(r.id, 'work')).status).toBe('PROCESSING');
    clock = new Date(clock.getTime() + 300_000);
    await runOnce(deps(new FakeRenderer(), new FakeSender()));
    expect((await jobFor(r.id, 'work')).status).toBe('GENERATED');
  });
});

describe('G4: 運搬帳票（CHG-003）・実 Chromium・Mailpit adapter', () => {
  it('運搬確定 → DELIVERY_REPORT_V1（実 Chromium、日本語フォント埋込）→ SUBMITTED、メールなし', async () => {
    const r = await confirmDelivery();
    const renderer = new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']);
    const sender = new FakeSender();
    try {
      await runOnce(deps(renderer, sender));
    } finally {
      await renderer.close();
    }
    const job = await jobFor(r.id, 'delivery');
    expect(job.status, JSON.stringify(job)).toBe('GENERATED');
    const file = await one<{ storage_key: string }>('SELECT storage_key FROM app.files WHERE id=$1', [job.file_id]);
    expect(file.storage_key).toContain(`運搬_2026-10-08_C1_${r.reportNo}_r1.pdf`);
    const pdf = await readFile(join(storageDir, file.storage_key));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/NotoSansJP/);
    expect((await one<{ status: string }>('SELECT status FROM app.delivery_reports WHERE id = $1', [r.id])).status).toBe('SUBMITTED');
    expect(Number((await one<{ n: string }>('SELECT count(*) n FROM app.mail_jobs WHERE document_job_id = $1', [job.id])).n)).toBe(0);
    expect(sender.sent).toHaveLength(0);
    // 目視確認用に保存（batch で開ける場所）
    const out = process.env['G4_SAMPLE_DIR'];
    if (out) {
      await mkdir(out, { recursive: true });
      await copyFile(join(storageDir, file.storage_key), join(out, 'sample-delivery-report.pdf'));
    }
  });

  it('Mailpit adapter: 送信 → 同じ Message-ID は findSent で検出、未知は null', async () => {
    if (MAILPIT_URL === undefined) throw new Error('MAILPIT_URL が未設定です（docker compose up -d mailpit）');
    const sender = new MailpitMailSender(MAILPIT_URL, 'inspexor-itest@example.invalid');
    const messageId = `<itest-${Date.now()}@mail.inspexor>`;
    expect(await sender.findSent(messageId)).toBeNull();
    const id = await sender.send({ messageId, to: ['tanto@example.com'], cc: [], bcc: [], subject: '【INSPEXOR作業報告】試験', text: '本文', attachments: [{ filename: '日報_試験.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF') }] });
    expect(typeof id).toBe('string');
    expect(await sender.findSent(messageId)).toBe(id);
  });
});
