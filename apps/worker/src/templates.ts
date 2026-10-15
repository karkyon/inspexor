/**
 * template registry（帳票・メール定義書: type/version/provider id/sha256/active_from を保存、生成時 version 固定）と
 * revision snapshot → placeholder 値の組立て。fixture HTML は apps/worker/templates/ に置く。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, formatMinutes, hoursLabel, jaClock, missingPlaceholders, toJstParts, toWareki, type TemplateType, type TemplateValue } from '@inspexor/domain';
import {
  C,
  reportPath,
  revisionPath,
  templateVersionPath,
  type DeliveryRevisionDoc,
  type DocReader,
  type DocStore,
  type ReportHeaderDoc,
  type TemplateVersionDoc,
  type WorkRevisionDoc,
} from '@inspexor/docstore';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const TEMPLATE_FILES: Readonly<Record<TemplateType, string>> = {
  DAILY_REPORT_V1: 'daily-report-v1.html',
  DAILY_REPORT_V2: 'daily-report-v2.html',
  DELIVERY_REPORT_V1: 'delivery-report-v1.html',
  DELIVERY_REPORT_V2: 'delivery-report-v2.html',
  // CHG-011 請求書（鏡・明細）
  INVOICE_COVER_V1: 'invoice-cover-v1.html',
  INVOICE_DETAIL_V1: 'invoice-detail-v1.html',
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
/** 登録確認済みの template（store ごと。同じ process では2回目以降 Firestore を読まない） */
const registered = new WeakMap<DocStore, Set<string>>();

export async function ensureRegistered(store: DocStore, t: LoadedTemplate, now: Date): Promise<'ok' | 'hash_mismatch'> {
  const path = templateVersionPath(t.type, 'V1');
  const cacheKey = `${path}:${t.sha256}`;
  if (registered.get(store)?.has(cacheKey) === true) return 'ok';
  // 登録済みなら transaction 不要（通常はこちら）
  const existing = await store.get<TemplateVersionDoc>(path);
  const current =
    existing ??
    (await store.runTransaction(async (tx) => {
      const found = await tx.get<TemplateVersionDoc>(path);
      if (found !== null) return found;
      const doc: TemplateVersionDoc = { templateType: t.type, version: 'V1', providerTemplateId: t.providerTemplateId, sha256: t.sha256, activeFrom: now };
      tx.create(path, doc);
      return doc;
    }));
  if (current.sha256 !== t.sha256) return 'hash_mismatch';
  const set = registered.get(store) ?? new Set<string>();
  set.add(cacheKey);
  registered.set(store, set);
  return 'ok';
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

/** 作業結果報告書（V2）の作業者欄の最小行数（現行帳票は10行） */
export const WORKER_ROWS_MIN = 10;

/**
 * 作業 revision（確定済み）→ 日報の値。確定版だけを対象にする（未確定なら null）。
 * type: DAILY_REPORT_V1（G4 の仮様式）/ DAILY_REPORT_V2（CHG-005: 現行「作業結果報告書」様式）。帳票 job の版に合わせる
 */
/** 帳票の元（確定済みの版）。document job が持つ */
export interface SnapshotSource {
  readonly reportId: string;
  readonly revisionId: string;
}

interface Named {
  code: string;
  name: string;
  active: boolean;
}

async function named(db: DocReader, collection: string, id: string | null): Promise<Named | null> {
  if (id === null) return null;
  return db.get<Named>(`${collection}/${id}`);
}

export async function workSnapshot(db: DocReader, src: SnapshotSource, type: 'DAILY_REPORT_V1' | 'DAILY_REPORT_V2' = 'DAILY_REPORT_V2'): Promise<DocumentSnapshot | null> {
  const rev = await db.get<WorkRevisionDoc>(revisionPath('WORK', src.reportId, src.revisionId));
  const header = await db.get<ReportHeaderDoc>(reportPath('WORK', src.reportId));
  if (rev === null || header === null || rev.confirmedAt === null) return null;
  const [customer, product, workType, location, vehicle] = await Promise.all([
    named(db, C.customers, rev.customerId),
    named(db, C.products, rev.productId),
    named(db, C.workTypes, rev.workTypeId),
    named(db, C.workLocations, rev.workLocationId),
    named(db, C.vehicles, rev.vehicleId),
  ]);
  const reporter = await db.get<{ displayName: string }>(`${C.users}/${rev.reporterId}`);
  if (customer === null || product === null || workType === null) return null;
  const workerDocs = await db.getMany<Named>(rev.workerIds.map((id) => `${C.workers}/${id}`));
  // 作業者は版に作業者コード順で保存済み
  const workers = { rows: workerDocs.filter((w): w is Named => w !== null).map((w) => ({ name: w.name })) };
  // 不良は版に不良種の並び順（sortOrder, code）で保存済み
  const defectDocs = await db.getMany<Named>(rev.defects.map((d) => `${C.defectTypes}/${d.defectTypeId}`));
  const defects = { rows: rev.defects.map((d, i) => ({ name: defectDocs[i]?.name ?? '', quantity: d.quantity })) };
  const row: Record<string, unknown> = {
    report_no: header.reportNo,
    header_id: src.reportId,
    revision_no: rev.revisionNo,
    confirmed_at: rev.confirmedAt,
    work_date: rev.workDate,
    start_at: rev.startAt,
    end_at: rev.endAt,
    customer_code: customer.code,
    customer_name: customer.name,
    customer_id: rev.customerId,
    product_code: product.code,
    product_name: product.name,
    product_id: rev.productId,
    work_type_name: workType.name,
    reporter_name: reporter?.displayName ?? '',
    work_location_name: location?.name ?? null,
    vehicle_name: vehicle?.name ?? null,
    lot_no: rev.lotNo,
    quantity: rev.quantity,
    break_minutes: rev.breakMinutes,
    regular_minutes: rev.regularMinutes,
    overtime_minutes: rev.overtimeMinutes,
    regular_person_minutes: rev.regularPersonMinutes,
    overtime_person_minutes: rev.overtimePersonMinutes,
    remarks: rev.remarks,
  };
  const total = defects.rows.reduce((s, d) => s + d.quantity, 0);
  const rows = defects.rows.filter((d) => d.quantity > 0);
  const start = toJstParts(row['start_at'] as Date);
  const end = toJstParts(row['end_at'] as Date);
  const workDate = row['work_date'] as string;
  const endTime = end.date !== workDate && end.time === '00:00' ? '24:00' : end.time;
  const fileName = { date: workDate, customerCode: row['customer_code'] as string, reportNo: row['report_no'] as string, revisionNo: row['revision_no'] as number };
  const mail = {
    workDate,
    productCode: row['product_code'] as string,
    productId: row['product_id'] as string,
    customerId: row['customer_id'] as string,
    customerName: row['customer_name'] as string,
    productName: row['product_name'] as string,
  };
  if (type === 'DAILY_REPORT_V2') {
    // 担当者: 品番の日報担当（お客様担当者マスタ）。未登録なら空欄
    const contacts = await db.query<{ name: string; code: string; customerId: string; active: boolean }>(C.customerContacts, {
      where: [{ field: 'dailyProductIds', op: 'array-contains', value: rev.productId }],
    });
    const contactRow = contacts
      .filter((c) => c.data.active)
      .sort((x, y) => (x.data.code < y.data.code ? -1 : x.data.code > y.data.code ? 1 : x.id < y.id ? -1 : 1))[0];
    const contact = { rows: contactRow === undefined ? [] : [{ name: contactRow.data.name }] };
    // 内訳: 品番の不良種別すべて（有効）＋実績。0 は空欄（現行帳票と同じ）
    const qty = new Map(rev.defects.map((d) => [d.defectTypeId, d.quantity]));
    const allTypes = await db.query<{ name: string; code: string; sortOrder: number; active: boolean }>(C.defectTypes, { where: [{ field: 'productId', op: '==', value: rev.productId }] });
    const types = {
      rows: allTypes
        .filter((t) => t.data.active || qty.has(t.id))
        .sort((x, y) => x.data.sortOrder - y.data.sortOrder || (x.data.code < y.data.code ? -1 : x.data.code > y.data.code ? 1 : 0))
        .map((t) => ({ id: t.id, name: t.data.name, quantity: qty.get(t.id) ?? null })),
    };
    const actual = (row['regular_minutes'] as number) + (row['overtime_minutes'] as number);
    const span = `${jaClock(start.time)} 〜 ${jaClock(endTime)}`;
    const rowCount = Math.max(WORKER_ROWS_MIN, workers.rows.length);
    const lines: string[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      const w = workers.rows[i];
      const label = i === 0 ? `<th class="vlabel" rowspan="${rowCount}">現地作業時間<br>及び作業者名</th>` : '';
      lines.push(
        w === undefined
          ? `<tr class="w-row">${label}<td>［　　　　　］　　時　　分 〜　　時　　分（　　　H）</td><td class="brk">昼休憩　　　H</td></tr>`
          : `<tr class="w-row">${label}<td>［ ${escapeHtml(w.name)} ］ ${span}（<span class="hrs">${hoursLabel(actual)}</span> H）</td><td class="brk">昼休憩 ${hoursLabel(row['break_minutes'] as number)} H</td></tr>`,
      );
    }
    const breakdown = types.rows.length === 0 ? '—' : total === 0 ? '不具合なし' : types.rows.map((t) => `${escapeHtml(t.name)}　${t.quantity === null || t.quantity === 0 ? '' : n(t.quantity)}`).join('<br>');
    return {
      type: 'DAILY_REPORT_V2',
      reportId: row['header_id'] as string,
      reportNo: row['report_no'] as string,
      values: {
        report_no: row['report_no'] as string,
        revision_no: String(row['revision_no']),
        confirmed_at: jstDateTime(row['confirmed_at'] as Date),
        customer_name: row['customer_name'] as string,
        contact_name: contact.rows[0] === undefined ? '' : `${contact.rows[0].name} 様`,
        work_date_jp: toWareki(workDate).text,
        work_location: (row['work_location_name'] as string | null) ?? '',
        vehicle: (row['vehicle_name'] as string | null) ?? '',
        worker_rows: { html: lines.join('') },
        work_type: row['work_type_name'] as string,
        product_code: row['product_code'] as string,
        product_name: row['product_name'] as string,
        lot_no: (row['lot_no'] as string | null) ?? '',
        quantity: n(row['quantity'] as number),
        defect_total: n(total),
        defect_breakdown: { html: breakdown },
        total_hours: hoursLabel((row['regular_person_minutes'] as number) + (row['overtime_person_minutes'] as number)),
        remarks: (row['remarks'] as string | null) ?? '—',
      },
      fileName,
      mail,
    };
  }
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
      end_time: endTime,
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

/**
 * 運搬 revision（確定済み）→ 帳票の値。type: DELIVERY_REPORT_V1（CHG-003）/ DELIVERY_REPORT_V2（CHG-010: 使用車両・運搬回数、和暦）。
 * 帳票 job の版に合わせる（作成済みの V1 は再出力も V1）
 */
export async function deliverySnapshot(
  db: DocReader,
  src: SnapshotSource,
  type: 'DELIVERY_REPORT_V1' | 'DELIVERY_REPORT_V2' = 'DELIVERY_REPORT_V2',
): Promise<DocumentSnapshot | null> {
  const rev = await db.get<DeliveryRevisionDoc>(revisionPath('DELIVERY', src.reportId, src.revisionId));
  const header = await db.get<ReportHeaderDoc>(reportPath('DELIVERY', src.reportId));
  if (rev === null || header === null || rev.confirmedAt === null) return null;
  const customer = await named(db, C.customers, rev.customerId);
  const driver = await named(db, C.workers, rev.driverId);
  if (customer === null || driver === null) return null;
  // 明細は版に品番コード順で保存済み
  const productDocs = await db.getMany<Named>(rev.items.map((i) => `${C.products}/${i.productId}`));
  const items = { rows: rev.items.map((i, k) => ({ code: productDocs[k]?.code ?? '', name: productDocs[k]?.name ?? '', quantity: i.quantity })) };
  const row: Record<string, unknown> = {
    report_no: header.reportNo,
    header_id: src.reportId,
    revision_no: rev.revisionNo,
    delivery_date: rev.deliveryDate,
    driver_name: driver.name,
    customer_code: customer.code,
    customer_name: customer.name,
    confirmed_at: rev.confirmedAt,
  };
  const date = row['delivery_date'] as string;
  const itemRows = {
    html: items.rows.map((i) => `<tr><td>${escapeHtml(i.code)}</td><td>${escapeHtml(i.name)}</td><td class="num">${n(i.quantity)}</td></tr>`).join(''),
  };
  const fileName = { date, customerCode: row['customer_code'] as string, reportNo: row['report_no'] as string, revisionNo: row['revision_no'] as number };
  if (type === 'DELIVERY_REPORT_V2') {
    const vehicle = await named(db, C.vehicles, rev.vehicleId);
    return {
      type: 'DELIVERY_REPORT_V2',
      reportId: row['header_id'] as string,
      reportNo: row['report_no'] as string,
      values: {
        report_no: row['report_no'] as string,
        revision_no: String(row['revision_no']),
        confirmed_at: jstDateTime(row['confirmed_at'] as Date),
        delivery_date_jp: toWareki(date).text,
        driver_name: row['driver_name'] as string,
        customer_code: row['customer_code'] as string,
        customer_name: row['customer_name'] as string,
        vehicle: vehicle?.name ?? '',
        trip_count: String(rev.tripCount),
        item_rows: itemRows,
        item_count: String(items.rows.length),
        total_quantity: n(items.rows.reduce((s, i) => s + i.quantity, 0)),
      },
      fileName,
      mail: null,
    };
  }
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
