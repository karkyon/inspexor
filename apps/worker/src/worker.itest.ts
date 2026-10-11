/**
 * G4 統合試験（T-DOC-001〜 / T-MAIL-001〜 / REQ-DOC-001 / REQ-MAIL-001 / CHG-003）。
 * CHG-006: Firestore（エミュレータ、無ければ MemoryDocStore）に、web の FieldReportService で実績を確定し、
 * worker の runOnce（dispatch → 帳票 → メール）を通しで検証する。PDF は実 Chromium と試験用 renderer の両方を使う。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jstToInstant } from '@inspexor/domain';
import {
  auditEventsFor,
  C,
  createUser,
  LocalFsStorage,
  type DocumentJobDoc,
  type FileDoc,
  type MailJobDoc,
  type OutboxDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { MasterService } from '../../web/lib/masters/master-service';
import { MASTER_DEFS, type MasterType } from '../../web/lib/masters/definitions';
import { writeSchema } from '../../web/lib/masters/schemas';
import { FieldReportService } from '../../web/lib/field/field-report-service';
import { ChromiumPdfRenderer } from './adapters/chromium-pdf';
import { MailpitMailSender } from './adapters/mailpit-mail';
import { dispatchOutbox } from './dispatcher';
import { AdapterError, type MailMessage, type MailSender, type PdfRenderer } from './ports';
import { runOnce, type WorkerDeps } from './worker';

const MAILPIT_URL = process.env['MAILPIT_URL'];
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
let t: TestStore;
let storageDir: string;
let fieldUser: string;
const m: Record<string, string> = {};
let clock = new Date('2026-10-08T03:00:00.000Z');

class FakeRenderer implements PdfRenderer {
  calls = 0;
  failNext = 0;
  lastHtml = '';
  async render(html: string): Promise<Buffer> {
    this.calls += 1;
    this.lastHtml = html;
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

async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  const parsed = writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>;
  return (await new MasterService(t.store).create(type, parsed, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: clock })).id;
}

const header = async (type: 'work' | 'delivery', id: string): Promise<ReportHeaderDoc> =>
  (await t.store.get<ReportHeaderDoc>(`${type === 'work' ? C.workReports : C.deliveryReports}/${id}`)) as ReportHeaderDoc;

async function mailJobs(documentJobId: string): Promise<Array<MailJobDoc & { id: string }>> {
  return (await t.store.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'documentJobId', op: '==', value: documentJobId }] })).map((r) => ({ ...r.data, id: r.id }));
}

async function outboxCount(type: string, aggregateId?: string): Promise<number> {
  return (await t.store.query<OutboxDoc>(C.outbox, { where: [{ field: 'type', op: '==', value: type }] })).filter((o) => aggregateId === undefined || o.data.aggregateId === aggregateId).length;
}

function deps(renderer: PdfRenderer, sender: MailSender, templateDir?: string): WorkerDeps {
  return { store: t.store, storage: new LocalFsStorage(storageDir), pdf: renderer, sender, now: () => clock, dailyMailEnabled: true, ...(templateDir ? { templateDir } : {}) };
}

const ctx = () => ({ actor: { userId: fieldUser, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000001', now: clock });

async function confirmWork(productKey = 'pA'): Promise<{ id: string; reportNo: string }> {
  const svc = new FieldReportService(t.store);
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
      workLocationId: null,
      vehicleId: null,
      remarks: null,
    },
    ctx(),
  );
  await svc.confirm('WORK', r.id, 1, ctx());
  return { id: r.id, reportNo: r.reportNo };
}

async function confirmDelivery(): Promise<{ id: string; reportNo: string }> {
  const svc = new FieldReportService(t.store);
  const r = await svc.createDelivery(
    { deliveryDate: '2026-10-08', driverId: m['w1'] as string, customerId: m['customer'] as string, items: [{ productId: m['pA'] as string, quantity: 1200 }, { productId: m['pNoMail'] as string, quantity: 8 }], vehicleId: null, tripCount: 1, deliveryFeeYen: null },
    ctx(),
  );
  await svc.confirm('DELIVERY', r.id, 1, ctx());
  return { id: r.id, reportNo: r.reportNo };
}

/** 実績の最新の帳票 job（PostgreSQL 版の列名に合わせて返す） */
async function jobFor(reportId: string, _type: 'work' | 'delivery') {
  const rows = (await t.store.query<DocumentJobDoc>(C.documents, { where: [{ field: 'reportId', op: '==', value: reportId }] })).sort(
    (a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime() || (a.id < b.id ? 1 : -1),
  );
  const j = rows[0];
  if (j === undefined) throw new Error(`job not found: ${reportId}`);
  return { id: j.id, status: j.data.status, error_code: j.data.errorCode, attempts: j.data.attempts, file_id: j.data.fileId, idempotency_key: j.data.idempotencyKey, template_version: j.data.templateVersion };
}

beforeAll(async () => {
  t = createTestStore('worker');
  storageDir = await mkdtemp(join(tmpdir(), 'inspexor-storage-'));
  fieldUser = (await createUser(t.store, { loginId: 'itest-field', passwordHash: 'x', displayName: '現場 太郎', roles: ['FIELD'] }, clock)) as string;
  m['customer'] = await master('customers', { code: 'C1', name: '合成顧客＆<A>', closingDay: 31 });
  for (const key of ['pA', 'pNoMail']) {
    m[key] = await master('products', { customerId: m['customer'], code: key.toUpperCase(), name: `品${key}`, settlementType: 'QUANTITY' });
    m[`wt_${key}`] = await master('work-types', { productId: m[key], code: 'INSP', name: '外観検査' });
    m[`d_${key}`] = await master('defects', { productId: m[key], code: 'D1', name: 'バリ', sortOrder: 1 });
  }
  m['w1'] = await master('workers', { code: 'W1', name: '作業者 一郎' });
  m['w2'] = await master('workers', { code: 'W2', name: '作業者 二郎' });
  await master('contacts', { customerId: m['customer'], code: 'K1', name: '担当', email: 'tanto@example.com', sendDaily: true, dailyProductIds: [m['pA']] });
  // pNoMail には DAILY 担当なし（宛先0件 → 帳票は作成、送信は FAILED_FINAL）
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('G4: 帳票 job（T-DOC-001 placeholder 残存は先に検査）', () => {
  it('未置換 placeholder を含む template は FAILED_FINAL（TEMPLATE_INVALID）、メール job なし、実績は CONFIRMED のまま', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inspexor-tpl-'));
    const html = await readFile(join(TEMPLATE_DIR, 'daily-report-v2.html'), 'utf8');
    await writeFile(join(dir, 'daily-report-v2.html'), html.replace('</body>', '<p>{{unknown_field}}</p></body>'));
    const r = await confirmWork();
    const renderer = new FakeRenderer();
    await runOnce(deps(renderer, new FakeSender(), dir));
    const job = await jobFor(r.id, 'work');
    expect(job).toMatchObject({ status: 'FAILED_FINAL', error_code: 'TEMPLATE_INVALID', file_id: null });
    expect(renderer.calls).toBe(0);
    expect(await mailJobs(job.id)).toHaveLength(0);
    expect((await header('work', r.id)).status).toBe('CONFIRMED');
    expect((await header('work', r.id)).documentStatus).toBe('FAILED_FINAL');
    expect((await auditEventsFor(t.store, 'DOCUMENT_JOB', job.id)).filter((a) => a.action === 'DOCUMENT_FAILED')).toHaveLength(1);
    expect(await outboxCount('DocumentFailed', job.id)).toBe(1);
    // この試験で registry に登録された改変版を消す（以降は正規の template を使う）
    const reg = await t.store.query(C.templateVersions);
    await t.store.runTransaction(async (tx) => {
      for (const x of reg) tx.delete(x.path);
    });
  });
});

describe('CHG-005: 作業結果報告書（DAILY_REPORT_V2）', () => {
  it('新しく確定した日報は V2 様式: 和暦・作業者ごとの時間・担当者・作業場所・使用車・内訳・総時間数・備考', async () => {
    const loc = await master('work-locations', { code: 'L1', name: '三成興業 作業場' });
    const car = await master('vehicles', { code: 'V1', name: 'キャラバン' });
    await master('defects', { productId: m['pA'], code: 'D2', name: '注入口', sortOrder: 2 });
    const svc = new FieldReportService(t.store);
    const r = await svc.createWork(
      {
        workDate: '2026-10-08', reporterId: fieldUser, customerId: m['customer'] as string, productId: m['pA'] as string, workTypeId: m['wt_pA'] as string,
        lotNo: '8, 5/24', workerIds: [m['w1'] as string, m['w2'] as string], startAt: jstToInstant('2026-10-08', '09:30'), endAt: jstToInstant('2026-10-08', '11:25'),
        quantity: 1600, defects: [{ defectTypeId: m['d_pA'] as string, quantity: 2 }], workLocationId: loc, vehicleId: car, remarks: '特記事項なし',
      },
      ctx(),
    );
    await svc.confirm('WORK', r.id, 1, ctx());
    const renderer = new FakeRenderer();
    await runOnce(deps(renderer, new FakeSender()));
    const job = await jobFor(r.id, 'work');
    expect(job.status).toBe('GENERATED');
    expect(job.template_version).toBe('DAILY_REPORT_V2');
    const html = renderer.lastHtml;
    expect(html).not.toMatch(/\{\{/);
    for (const text of ['作業結果報告書', '令和 8 年 10 月 8 日（木）', '担当 様', '三成興業 作業場', 'キャラバン', '［ 作業者 一郎 ］ 9時30分 〜 11時25分', '1.92', '昼休憩 0.00 H', '外観検査', 'バリ　2', '注入口　', '3.83', '特記事項なし', '合成顧客＆&lt;A&gt;']) {
      expect(html, text).toContain(text);
    }
    // 作業者欄は最低10行（現行帳票）
    expect(html.match(/class="w-row"/g)).toHaveLength(10);
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
    expect((await header('work', r.id)).status).toBe('SUBMITTED');
    expect(await mailJobs(job.id)).toHaveLength(0);
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
    const file = (await t.store.get<FileDoc>(`${C.files}/${job.file_id as string}`)) as FileDoc;
    expect(file.storageKey).toMatch(new RegExp(`^documents/DAILY_REPORT/${r.reportNo}/${job.id}/日報_2026-10-08_C1_${r.reportNo}_r1\\.pdf$`));
    const bytes = await readFile(join(storageDir, file.storageKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    expect(file).toMatchObject({ mimeType: 'application/pdf', classification: 'CONFIDENTIAL' });
    const h = await header('work', r.id);
    expect({ status: h.status, version: h.version, documentId: h.documentId, documentStatus: h.documentStatus }).toEqual({ status: 'SUBMITTED', version: 3, documentId: job.id, documentStatus: 'GENERATED' });
    for (const type of ['DocumentGenerated', 'RecordSubmitted', 'MailSent']) {
      expect(await outboxCount(type), type).toBeGreaterThanOrEqual(1);
    }
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0];
    expect(mail?.subject).toBe(`【INSPEXOR作業報告】2026-10-08 PA ${r.reportNo}`);
    expect(mail?.to).toEqual(['tanto@example.com']);
    expect(mail?.attachments.map((a) => a.filename)).toEqual([`日報_2026-10-08_C1_${r.reportNo}_r1.pdf`]);
    expect(mail?.text).toContain('自動送信');
    const mj = (await mailJobs(job.id))[0];
    expect(mj).toMatchObject({ status: 'SENT', providerMessageId: 'fake-1' });
    // audit には宛先アドレス・本文を残さない（SEC-017）
    const audit = (await auditEventsFor(t.store, 'MAIL_JOB', mj?.id as string)).find((a) => a.action === 'MAIL_SENT');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.afterData)).not.toContain('example.com');
  });

  it('同じ event の再配送でも job は1件（冪等 key）、生成済み job は再処理しない', async () => {
    const r = await confirmWork();
    await runOnce(deps(new FakeRenderer(), new FakeSender()));
    const events = (await t.store.query<OutboxDoc>(C.outbox, { where: [{ field: 'aggregateId', op: '==', value: r.id }] })).filter((o) => o.data.type === 'WorkReportConfirmed');
    await t.store.runTransaction(async (tx) => {
      for (const e of events) tx.update(e.path, { status: 'PENDING' });
    });
    const renderer = new FakeRenderer();
    await dispatchOutbox(t.store, clock);
    await runOnce(deps(renderer, new FakeSender()));
    expect(await t.store.count(C.documents, { where: [{ field: 'reportId', op: '==', value: r.id }] })).toBe(1);
    expect(renderer.calls).toBe(0);
  });

  it('宛先0件: 帳票は生成・提出、メールは FAILED_FINAL（RECIPIENT_EMPTY）', async () => {
    const r = await confirmWork('pNoMail');
    const sender = new FakeSender();
    await runOnce(deps(new FakeRenderer(), sender));
    const job = await jobFor(r.id, 'work');
    expect(job.status).toBe('GENERATED');
    expect((await header('work', r.id)).status).toBe('SUBMITTED');
    const mj = (await mailJobs(job.id))[0];
    expect({ status: mj?.status, error_code: mj?.errorCode }).toEqual({ status: 'FAILED_FINAL', error_code: 'RECIPIENT_EMPTY' });
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
    expect((await header('work', r.id)).status).toBe('CONFIRMED');
  });

  it('T-MAIL-001: 送信後に timeout → 再試行時は provider を検索して重複送信 0', async () => {
    const r = await confirmWork();
    const sender = new FakeSender();
    sender.timeoutAfterSend = true;
    await runOnce(deps(new FakeRenderer(), sender));
    const job = await jobFor(r.id, 'work');
    const m1 = (await mailJobs(job.id))[0];
    expect({ status: m1?.status, attempts: m1?.attempts }).toEqual({ status: 'FAILED_RETRYABLE', attempts: 1 });
    clock = new Date(clock.getTime() + 11_000);
    await runOnce(deps(new FakeRenderer(), sender));
    const m2 = (await mailJobs(job.id))[0];
    expect({ status: m2?.status, attempts: m2?.attempts, provider_message_id: m2?.providerMessageId }).toEqual({ status: 'SENT', attempts: 2, provider_message_id: 'fake-1' });
    expect(sender.sent).toHaveLength(1);
  });

  it('lease 切れの PROCESSING は再取得、lease 内は取得しない', async () => {
    const r = await confirmWork();
    await dispatchOutbox(t.store, clock);
    const job = await jobFor(r.id, 'work');
    await t.store.runTransaction(async (tx) => tx.update(`${C.documents}/${job.id}`, { status: 'PROCESSING', updatedAt: new Date(clock.getTime() - 60_000) }));
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
    const file = (await t.store.get<FileDoc>(`${C.files}/${job.file_id as string}`)) as FileDoc;
    expect(file.storageKey).toContain(`運搬_2026-10-08_C1_${r.reportNo}_r1.pdf`);
    const pdf = await readFile(join(storageDir, file.storageKey));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/NotoSansJP/);
    expect((await header('delivery', r.id)).status).toBe('SUBMITTED');
    expect(await mailJobs(job.id)).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
    // 目視確認用に保存（batch で開ける場所）
    const out = process.env['G4_SAMPLE_DIR'];
    if (out) {
      await mkdir(out, { recursive: true });
      await copyFile(join(storageDir, file.storageKey), join(out, 'sample-delivery-report.pdf'));
    }
  });

  // Mailpit（開発用メール受信）が無い環境（サンドボックス）では省略。Cloud Shell のバッチは MAILPIT_URL を設定する
  it.skipIf(MAILPIT_URL === undefined)('Mailpit adapter: 送信 → 同じ Message-ID は findSent で検出、未知は null', async () => {
    const sender = new MailpitMailSender(MAILPIT_URL, 'inspexor-itest@example.invalid');
    const messageId = `<itest-${Date.now()}@mail.inspexor>`;
    expect(await sender.findSent(messageId)).toBeNull();
    const id = await sender.send({ messageId, to: ['tanto@example.com'], cc: [], bcc: [], subject: '【INSPEXOR作業報告】試験', text: '本文', attachments: [{ filename: '日報_試験.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF') }] });
    expect(typeof id).toBe('string');
    expect(await sender.findSent(messageId)).toBe(id);
  });
});
