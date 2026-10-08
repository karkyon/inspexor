/**
 * template registry（帳票・メール定義書: type/version/provider id/sha256/active_from を保存、生成時 version 固定）と
 * revision snapshot → placeholder 値の組立て。fixture HTML は apps/worker/templates/ に置く。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, formatMinutes, missingPlaceholders, toJstParts, type TemplateType, type TemplateValue } from '@inspexor/domain';
import type { Queryable } from './db';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const TEMPLATE_FILES: Readonly<Record<TemplateType, string>> = {
  DAILY_REPORT_V1: 'daily-report-v1.html',
  DELIVERY_REPORT_V1: 'delivery-report-v1.html',
};

export interface LoadedTemplate {
  readonly type: TemplateType;
  readonly html: string;
  readonly sha256: string;
  readonly providerTemplateId: string;
}

export function loadFixtureTemplate(type: TemplateType, dir = TEMPLATE_DIR): LoadedTemplate {
  const html = readFileSync(join(dir, TEMPLATE_FILES[type]), 'utf8');
  const missing = missingPlaceholders(html, type);
  if (missing.length > 0) throw new Error(`template ${type} に必須 placeholder がありません: ${missing.join(', ')}`);
  return { type, html, sha256: createHash('sha256').update(html, 'utf8').digest('hex'), providerTemplateId: `fixture:${TEMPLATE_FILES[type]}` };
}

/**
 * registry に登録（無ければ追加）。登録済みの sha256 と原本が違う場合は使わない（version 固定の破れ＝TEMPLATE_INVALID）。
 */
export async function ensureRegistered(db: Queryable, t: LoadedTemplate, now: Date): Promise<'ok' | 'hash_mismatch'> {
  await db.query(
    `INSERT INTO app.template_versions (template_type, version, provider_template_id, sha256, active_from)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (template_type, version) DO NOTHING`,
    [t.type, 'V1', t.providerTemplateId, t.sha256, now.toISOString()],
  );
  const r = await db.query<{ sha256: string }>('SELECT sha256 FROM app.template_versions WHERE template_type = $1 AND version = $2', [t.type, 'V1']);
  return r.rows[0]?.sha256.trim() === t.sha256 ? 'ok' : 'hash_mismatch';
}

const n = (v: number) => v.toLocaleString('ja-JP');
function jstDateTime(d: Date): string {
  const p = toJstParts(d);
  return `${p.date} ${p.time}`;
}

export interface DocumentSnapshot {
  readonly type: TemplateType;
  readonly values: Record<string, TemplateValue>;
  readonly fileName: { date: string; customerCode: string; reportNo: string; revisionNo: number };
  readonly reportId: string;
  readonly reportNo: string;
  readonly mail: { workDate: string; productCode: string; productId: string; customerId: string; customerName: string; productName: string } | null;
}

/** 作業 revision（確定済み）→ DAILY_REPORT_V1 の値。確定版だけを対象にする（未確定なら null） */
export async function workSnapshot(db: Queryable, revisionId: string): Promise<DocumentSnapshot | null> {
  const r = await db.query(
    `SELECT r.*, h.report_no, h.id AS header_id, c.code AS customer_code, c.name AS customer_name, p.code AS product_code, p.name AS product_name,
            wt.name AS work_type_name, u.display_name AS reporter_name
       FROM app.work_report_revisions r
       JOIN app.work_reports h ON h.id = r.report_id
       JOIN app.customers c ON c.id = r.customer_id
       JOIN app.products p ON p.id = r.product_id
       JOIN app.work_types wt ON wt.id = r.work_type_id
       JOIN app.users u ON u.id = r.reporter_id
      WHERE r.id = $1 AND r.confirmed_at IS NOT NULL`,
    [revisionId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const workers = await db.query<{ name: string }>(
    `SELECT w.name FROM app.work_report_workers x JOIN app.workers w ON w.id = x.worker_id WHERE x.revision_id = $1 ORDER BY w.code, w.id`,
    [revisionId],
  );
  const defects = await db.query<{ name: string; quantity: number }>(
    `SELECT t.name, d.quantity FROM app.defect_results d JOIN app.defect_types t ON t.id = d.defect_type_id
      WHERE d.revision_id = $1 ORDER BY t.sort_order, t.code`,
    [revisionId],
  );
  const total = defects.rows.reduce((s, d) => s + d.quantity, 0);
  const rows = defects.rows.filter((d) => d.quantity > 0);
  const start = toJstParts(row['start_at'] as Date);
  const end = toJstParts(row['end_at'] as Date);
  const workDate = row['work_date'] as string;
  return {
    type: 'DAILY_REPORT_V1',
    reportId: row['header_id'] as string,
    reportNo: row['report_no'] as string,
    values: {
      report_no: row['report_no'] as string,
      revision_no: String(row['revision_no']),
      work_date: workDate,
      customer_code: row['customer_code'] as string,
      customer_name: row['customer_name'] as string,
      product_code: row['product_code'] as string,
      product_name: row['product_name'] as string,
      work_type: row['work_type_name'] as string,
      lot_no: (row['lot_no'] as string | null) ?? '—',
      reporter_name: row['reporter_name'] as string,
      worker_names: workers.rows.map((w) => w.name).join('、'),
      start_time: start.time,
      end_time: end.date !== workDate && end.time === '00:00' ? '24:00' : end.time,
      break_minutes: formatMinutes(row['break_minutes'] as number),
      regular_person_minutes: formatMinutes(row['regular_person_minutes'] as number),
      overtime_person_minutes: formatMinutes(row['overtime_person_minutes'] as number),
      quantity: n(row['quantity'] as number),
      // 0 不良は「不具合なし」（帳票・メール定義書 §日報）
      defect_rows: {
        html:
          rows.length === 0
            ? '<tr><td colspan="2">不具合なし</td></tr>'
            : rows.map((d) => `<tr><td>不良: ${escapeHtml(d.name)}</td><td class="num">${n(d.quantity)}</td></tr>`).join(''),
      },
      defect_total: n(total),
      confirmed_at: jstDateTime(row['confirmed_at'] as Date),
    },
    fileName: { date: workDate, customerCode: row['customer_code'] as string, reportNo: row['report_no'] as string, revisionNo: row['revision_no'] as number },
    mail: {
      workDate,
      productCode: row['product_code'] as string,
      productId: row['product_id'] as string,
      customerId: row['customer_id'] as string,
      customerName: row['customer_name'] as string,
      productName: row['product_name'] as string,
    },
  };
}

/** 運搬 revision（確定済み）→ DELIVERY_REPORT_V1 の値（CHG-003） */
export async function deliverySnapshot(db: Queryable, revisionId: string): Promise<DocumentSnapshot | null> {
  const r = await db.query(
    `SELECT r.*, h.report_no, h.id AS header_id, c.code AS customer_code, c.name AS customer_name, w.name AS driver_name
       FROM app.delivery_report_revisions r
       JOIN app.delivery_reports h ON h.id = r.report_id
       JOIN app.customers c ON c.id = r.customer_id
       JOIN app.workers w ON w.id = r.driver_id
      WHERE r.id = $1 AND r.confirmed_at IS NOT NULL`,
    [revisionId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const items = await db.query<{ code: string; name: string; quantity: number }>(
    `SELECT p.code, p.name, i.quantity FROM app.delivery_items i JOIN app.products p ON p.id = i.product_id
      WHERE i.delivery_revision_id = $1 ORDER BY p.code, p.id`,
    [revisionId],
  );
  const date = row['delivery_date'] as string;
  return {
    type: 'DELIVERY_REPORT_V1',
    reportId: row['header_id'] as string,
    reportNo: row['report_no'] as string,
    values: {
      report_no: row['report_no'] as string,
      revision_no: String(row['revision_no']),
      delivery_date: date,
      driver_name: row['driver_name'] as string,
      customer_code: row['customer_code'] as string,
      customer_name: row['customer_name'] as string,
      item_rows: {
        html: items.rows.map((i) => `<tr><td>${escapeHtml(i.code)}</td><td>${escapeHtml(i.name)}</td><td class="num">${n(i.quantity)}</td></tr>`).join(''),
      },
      item_count: String(items.rows.length),
      total_quantity: n(items.rows.reduce((s, i) => s + i.quantity, 0)),
      confirmed_at: jstDateTime(row['confirmed_at'] as Date),
    },
    fileName: { date, customerCode: row['customer_code'] as string, reportNo: row['report_no'] as string, revisionNo: row['revision_no'] as number },
    mail: null,
  };
}
