/**
 * CHG-011 統合試験（worker）: 請求書の鏡・明細の PDF（実 Chromium）→ 発行済み（ISSUED）→ 送付メール（添付2件）→ SENT。
 * web の BillingService / InvoiceService で請求を確定・発行・送付し、worker の runOnce で帳票とメールを処理する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jstToInstant } from '@inspexor/domain';
import {
  auditEventsFor,
  billingRunPath,
  C,
  createUser,
  documentPath,
  invoicePath,
  LocalFsStorage,
  reportPath,
  type BillingRunDoc,
  type DocumentJobDoc,
  type FileDoc,
  type InvoiceDoc,
  type MailJobDoc,
  type ReportHeaderDoc,
} from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { MasterService } from '../../web/lib/masters/master-service';
import { MASTER_DEFS, type MasterType } from '../../web/lib/masters/definitions';
import { writeSchema } from '../../web/lib/masters/schemas';
import { FieldReportService } from '../../web/lib/field/field-report-service';
import { BillingService } from '../../web/lib/billing/billing-service';
import { InvoiceService } from '../../web/lib/billing/invoice-service';
import { ChromiumPdfRenderer } from './adapters/chromium-pdf';
import { dispatchOutbox } from './dispatcher';
import { invoiceLines } from './invoice-jobs';
import type { MailMessage, MailSender, PdfRenderer } from './ports';
import { runOnce, type WorkerDeps } from './worker';

const SECRET = 'w'.repeat(32);
const clock = new Date('2026-10-08T03:00:00.000Z');
let t: TestStore;
let storageDir: string;
const users: Record<string, string> = {};
const m: Record<string, string> = {};
const env = { INVOICE_ISSUER_JSON: JSON.stringify({ postalCode: '712-8000', address: '岡山県倉敷市（試験住所）', registrationNo: 'T1234567890123', bankNote: '○○銀行 本店 普通 1234567\nサンセイコウギョウ（カ' }) };

class FakeSender implements MailSender {
  sent: Array<MailMessage & { id: string }> = [];
  async findSent(messageId: string): Promise<string | null> {
    return this.sent.find((s) => s.messageId === messageId)?.id ?? null;
  }
  async send(message: MailMessage): Promise<string> {
    const id = `fake-${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    return id;
  }
}

async function master(type: MasterType, input: Record<string, unknown>): Promise<string> {
  const parsed = writeSchema(MASTER_DEFS[type]).parse(input) as Record<string, unknown>;
  return (await new MasterService(t.store, { billing: true }).create(type, parsed, { actorId: 'itest', correlationId: '11111111-1111-4111-8111-111111111111', now: clock })).id;
}

const bctx = () => ({ actorId: users['office'] as string, roles: ['OFFICE' as const], correlationId: '00000000-0000-4000-8000-000000000002', now: clock });

/** 確定 → （帳票作成の代わりに）承認済み にする */
async function approvedWork(date: string, productKey: string, quantity: number): Promise<string> {
  const svc = new FieldReportService(t.store);
  const ctx = { actor: { userId: users['field'] as string, roles: ['FIELD'] }, correlationId: '00000000-0000-4000-8000-000000000001', now: clock };
  const r = await svc.createWork(
    {
      workDate: date, reporterId: users['field'] as string, customerId: m['customer'] as string, productId: m[productKey] as string, workTypeId: m[`wt_${productKey}`] as string,
      lotNo: null, workerIds: [m['w1'] as string], startAt: jstToInstant(date, '09:00'), endAt: jstToInstant(date, '10:00'), quantity, defects: [], workLocationId: null, vehicleId: null, remarks: null,
    },
    ctx,
  );
  await svc.confirm('WORK', r.id, 1, ctx);
  await t.store.runTransaction(async (tx) => {
    const h = (await tx.get<ReportHeaderDoc>(reportPath('WORK', r.id))) as ReportHeaderDoc;
    tx.update(reportPath('WORK', r.id), { status: 'APPROVED', version: h.version + 1, documentStatus: 'GENERATED' });
  });
  return r.id;
}

function deps(renderer: PdfRenderer, sender: MailSender): WorkerDeps {
  return { store: t.store, storage: new LocalFsStorage(storageDir), pdf: renderer, sender, now: () => clock };
}

beforeAll(async () => {
  t = createTestStore('worker-invoice');
  storageDir = await mkdtemp(join(tmpdir(), 'inspexor-inv-storage-'));
  for (const [who, role] of [['field', 'FIELD'], ['office', 'OFFICE']] as const) {
    users[who] = (await createUser(t.store, { loginId: `winv-${who}`, passwordHash: 'x', displayName: who, roles: [role] }, clock)) as string;
  }
  m['customer'] = await master('customers', { code: 'CV1', name: '請求顧客＆<試験>', closingDay: 31 });
  for (const key of ['pA', 'pB']) {
    m[key] = await master('products', { customerId: m['customer'], code: key.toUpperCase(), name: `品${key}`, settlementType: 'QUANTITY' });
    m[`wt_${key}`] = await master('work-types', { productId: m[key], code: 'INSP', name: '外観検査' });
  }
  m['w1'] = await master('workers', { code: 'W1', name: '作業者 一郎' });
  await master('rates', { productId: m['pA'], unitPrice: '4.4', validFrom: '2026-01-01' });
  await master('rates', { productId: m['pB'], unitPrice: '12.5', validFrom: '2026-01-01' });
  await master('fixed-charges', { productId: m['pA'], label: '保管料', amountYen: 5000, validFrom: '2026-01-01' });
  await master('contacts', { customerId: m['customer'], code: 'K1', name: '経理', email: 'keiri@example.com', sendInvoice: true });
  // 明細が複数ページになる件数（帳票の各ページに「請求書番号 n / 総ページ」）
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    await approvedWork(date, 'pA', 1000 + d);
    await approvedWork(date, 'pB', 10 + d);
  }
  // 日報の帳票 job は対象外（この試験は請求書だけを処理する）
  while ((await dispatchOutbox(t.store, clock)) > 0);
  for (const j of await t.store.query<DocumentJobDoc>(C.documents)) await t.store.runTransaction(async (tx) => tx.update(documentPath(j.id), { status: 'FAILED_FINAL', errorCode: 'TEST_SKIPPED' }));
}, 300_000);

afterAll(async () => {
  await t?.close();
});

describe('CHG-011: 請求書の帳票（worker）', () => {
  it('明細の規則: 除外した報告と0円の明細は出さない（固定費は0円でも出す）、No を振り直す', () => {
    const base = { reportNo: null, revisionId: null, businessDate: null, productId: 'p', productCode: 'P', unit: '個', quantity: '1', unitPrice: '0', multiplier: null, description: 'x', ruleId: null, ruleSnapshot: {}, calculation: {} };
    const lines = [
      { ...base, no: 1, lineType: 'WORK_QUANTITY', sourceType: 'WORK', reportId: 'r1', amountYen: 100 },
      { ...base, no: 2, lineType: 'WORK_QUANTITY', sourceType: 'WORK', reportId: 'r2', amountYen: 200 },
      { ...base, no: 3, lineType: 'WORK_QUANTITY', sourceType: 'WORK', reportId: 'r3', amountYen: 0 },
      { ...base, no: 4, lineType: 'FIXED_CHARGE', sourceType: 'FIXED_CHARGE', reportId: null, amountYen: 0 },
    ] as unknown as Parameters<typeof invoiceLines>[0];
    expect(invoiceLines(lines, ['r2']).map((l) => [l.no, l.reportId, l.amountYen])).toEqual([[1, 'r1', 100], [2, null, 0]]);
  });

  it('確定 → 発行 → 鏡・明細を実 Chromium で PDF 化 → 請求書・請求 run が ISSUED → 送付（添付2件）→ SENT', async () => {
    const billing = new BillingService(t.store);
    const invoices = new InvoiceService(t.store, SECRET, () => env);
    const run = await billing.create({ customerId: m['customer'] as string, periodEnd: '2026-09-30' }, bctx());
    const calc = await billing.calculate(run.id, { expectedVersion: 1 }, bctx());
    expect(calc.status).toBe('CALCULATED');
    const fin = await billing.finalize(run.id, { expectedVersion: calc.version }, bctx());
    const invoiceId = fin.invoiceId as string;
    const issued = await invoices.action(invoiceId, 'issue', { expectedVersion: 1 }, bctx());
    expect(issued.documents.map((d) => d.status)).toEqual(['QUEUED', 'QUEUED']);

    const renderer = new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']);
    const sender = new FakeSender();
    try {
      const r1 = await runOnce(deps(renderer, sender));
      expect(r1.documents).toHaveLength(2);
    } finally {
      await renderer.close();
    }
    const inv = (await t.store.get<InvoiceDoc>(invoicePath(invoiceId))) as InvoiceDoc;
    expect(inv.status).toBe('ISSUED');
    expect((await t.store.get<BillingRunDoc>(billingRunPath(run.id)))?.status).toBe('ISSUED');
    const out = process.env['G4_SAMPLE_DIR'];
    const texts: string[] = [];
    for (const [docId, prefix, sample] of [[inv.coverDocumentId, '請求書', 'sample-invoice-cover.pdf'], [inv.detailDocumentId, '請求明細', 'sample-invoice-detail.pdf']] as const) {
      const job = (await t.store.get<DocumentJobDoc>(documentPath(docId as string))) as DocumentJobDoc;
      expect(job.status, JSON.stringify(job)).toBe('GENERATED');
      const file = (await t.store.get<FileDoc>(`${C.files}/${job.fileId as string}`)) as FileDoc;
      expect(file.storageKey).toContain(`${prefix}_2026-09-30_CV1_INV-202609-CV1-001_r1.pdf`);
      const pdf = await readFile(join(storageDir, file.storageKey));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      texts.push(pdf.toString('latin1'));
      if (out) {
        await mkdir(out, { recursive: true });
        await copyFile(join(storageDir, file.storageKey), join(out, sample));
      }
    }
    expect(texts[0]).toMatch(/NotoSansJP/);
    // 明細は複数ページ（60件超）
    expect((texts[1]?.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
    expect((await auditEventsFor(t.store, 'INVOICE', invoiceId)).map((a) => a.action)).toContain('INVOICE_ISSUED');

    // 送付 → worker が添付2件で送信 → SENT
    const view = await invoices.get(invoiceId, clock);
    expect(view.documents.every((d) => d.url !== null)).toBe(true);
    await invoices.action(invoiceId, 'send', { expectedVersion: view.version }, bctx());
    const r2 = await runOnce(deps(new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']), sender));
    expect(r2.mails).toEqual(['sent']);
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0] as MailMessage;
    expect(mail.subject).toBe('【請求書送付】2026年9月分 INV-202609-CV1-001');
    expect(mail.to).toEqual(['keiri@example.com']);
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      '請求書_2026-09-30_CV1_INV-202609-CV1-001_r1.pdf',
      '請求明細_2026-09-30_CV1_INV-202609-CV1-001_r1.pdf',
    ]);
    expect(mail.text).toContain('ご請求金額:');
    expect(mail.text).toContain('お支払期限: 2026-10-31');
    const after = (await t.store.get<InvoiceDoc>(invoicePath(invoiceId))) as InvoiceDoc;
    expect(after).toMatchObject({ status: 'SENT', sendCount: 1 });
    expect((await t.store.get<BillingRunDoc>(billingRunPath(run.id)))?.status).toBe('SENT');
    const mj = (await t.store.query<MailJobDoc>(C.mailJobs, { where: [{ field: 'invoiceId', op: '==', value: invoiceId }] }))[0];
    expect(mj?.data.status).toBe('SENT');
    expect((await auditEventsFor(t.store, 'INVOICE', invoiceId)).map((a) => a.action)).toContain('INVOICE_SENT');
  });
});
