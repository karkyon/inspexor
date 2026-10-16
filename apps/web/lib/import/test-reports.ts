/**
 * CHG-013 試験用の業務データ（作業日報・運搬実績）を期間指定で作り、確定する（帳票は worker が作る）。
 *   - 画面と同じ FieldReportService を通す（入力規則・報告番号・版・監査・帳票の依頼が本番と同じ）
 *   - 値は乱数（seed を指定すれば同じ内容）。日曜は作らない。時刻は 5 分刻み、昼休憩をまたぐ作業・残業・不良あり/なしを混ぜる
 *   - 報告番号は作業日の月で採番されるよう、作成日時を作業日の正午（日本時間）にする
 *   - 本番で使うときは、お客様コードが TEST- で始まるものだけ（呼び出し側で確認）
 */
import { randomUUID } from 'node:crypto';
import { C, readUniqueOwner, type DocStore } from '@inspexor/docstore';
import { jstToInstant } from '@inspexor/domain';
import { FieldReportService } from '../field/field-report-service';

export interface TestReportOptions {
  readonly from: string;
  readonly to: string;
  readonly customerCodes: readonly string[];
  /** 報告者（現場の利用者 ID） */
  readonly reporterId: string;
  /** 1日あたりの作業日報の件数（既定 3） */
  readonly workPerDay?: number;
  /** 1日あたりの運搬実績の件数（既定 1） */
  readonly deliveryPerDay?: number;
  readonly seed?: number;
  /** false なら下書きのまま（既定 true＝確定） */
  readonly confirm?: boolean;
  /** 作業者・車両・作業場所をこの接頭辞のコードに限る（既定 'TEST-'。空文字なら全部） */
  readonly masterPrefix?: string;
}

export interface TestReportResult {
  readonly work: number;
  readonly delivery: number;
  readonly reportNos: readonly string[];
  readonly days: number;
}

type Row = { id: string; data: Record<string, unknown> };

/** 再現できる乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

async function active(store: DocStore, collection: string, where?: { field: string; value: string }): Promise<Row[]> {
  const rows = await store.query<Record<string, unknown>>(collection, where === undefined ? {} : { where: [{ field: where.field, op: '==', value: where.value }] });
  return rows.filter((r) => r.data['active'] !== false).sort((a, b) => String(a.data['code']).localeCompare(String(b.data['code'])));
}

export async function generateTestReports(store: DocStore, opts: TestReportOptions): Promise<TestReportResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to) || opts.from > opts.to) throw new Error('期間（from/to）は YYYY-MM-DD で、from ≦ to にしてください。');
  const list = days(opts.from, opts.to);
  if (list.length > 93) throw new Error('期間は93日（約3か月）までにしてください。');
  const random = rng(opts.seed ?? 20261016);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(random() * a.length)] as T;
  const prefix = opts.masterPrefix ?? 'TEST-';
  const byPrefix = (rows: Row[]) => rows.filter((r) => prefix === '' || String(r.data['code']).startsWith(prefix));

  const customers: Array<{ id: string; code: string; products: Array<{ id: string; lotRequired: boolean; workTypes: string[]; defects: string[] }> }> = [];
  for (const code of opts.customerCodes) {
    const id = await readUniqueOwner(store, 'master:customers', '-', code);
    if (id === null) throw new Error(`お客様コード「${code}」がありません。`);
    const products = [];
    for (const p of await active(store, C.products, { field: 'customerId', value: id })) {
      const workTypes = (await active(store, C.workTypes, { field: 'productId', value: p.id })).map((w) => w.id);
      const defects = (await active(store, C.defectTypes, { field: 'productId', value: p.id })).map((d) => d.id);
      if (workTypes.length > 0) products.push({ id: p.id, lotRequired: p.data['lotRequired'] === true, workTypes, defects });
    }
    if (products.length === 0) throw new Error(`お客様「${code}」に、作業内容のある有効な品番がありません。`);
    customers.push({ id, code, products });
  }
  const workers = byPrefix(await active(store, C.workers)).map((w) => w.id);
  const vehicles = byPrefix(await active(store, C.vehicles)).map((v) => v.id);
  const locations = byPrefix(await active(store, C.workLocations)).map((l) => l.id);
  if (workers.length === 0) throw new Error(`有効な作業者がありません${prefix !== '' ? `（コードが ${prefix} で始まるもの）` : ''}。`);

  const svc = new FieldReportService(store);
  const reportNos: string[] = [];
  let work = 0;
  let delivery = 0;
  let workedDays = 0;
  for (const day of list) {
    if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) continue;
    workedDays += 1;
    const now = new Date(jstToInstant(day, '12:00'));
    const ctx = { actor: { userId: opts.reporterId, roles: ['FIELD'] }, correlationId: randomUUID(), now };
    for (let i = 0; i < (opts.workPerDay ?? 3); i += 1) {
      const c = pick(customers);
      const p = pick(c.products);
      const start = 8 * 60 + Math.floor(random() * 84) * 5; // 8:00〜14:55
      const span = 30 + Math.floor(random() * 60) * 5; // 30分〜5時間25分
      const end = Math.min(start + span, 23 * 60);
      const team = [...new Set(Array.from({ length: 1 + Math.floor(random() * Math.min(3, workers.length)) }, () => pick(workers)))];
      const quantity = 50 + Math.floor(random() * 40) * 50;
      const defects = p.defects.length > 0 && random() < 0.5 ? [{ defectTypeId: pick(p.defects), quantity: 1 + Math.floor(random() * 5) }] : [];
      const created = await svc.createWork(
        {
          workDate: day,
          reporterId: opts.reporterId,
          customerId: c.id,
          productId: p.id,
          workTypeId: pick(p.workTypes),
          lotNo: p.lotRequired || random() < 0.3 ? `LOT-${day.replace(/-/g, '').slice(2)}-${i + 1}` : null,
          workerIds: team,
          startAt: jstToInstant(day, hhmm(start)),
          endAt: jstToInstant(day, hhmm(end)),
          quantity,
          defects,
          workLocationId: locations.length > 0 && random() < 0.7 ? pick(locations) : null,
          vehicleId: vehicles.length > 0 && random() < 0.3 ? pick(vehicles) : null,
          remarks: random() < 0.2 ? '試験用データ' : null,
        },
        ctx,
      );
      if (opts.confirm !== false) await svc.confirm('WORK', created.id, created.version, ctx);
      reportNos.push(created.reportNo);
      work += 1;
    }
    for (let i = 0; i < (opts.deliveryPerDay ?? 1); i += 1) {
      const c = pick(customers);
      const items = [...new Map(Array.from({ length: 1 + Math.floor(random() * Math.min(3, c.products.length)) }, () => pick(c.products)).map((p) => [p.id, p])).values()].map((p) => ({
        productId: p.id,
        quantity: 100 + Math.floor(random() * 30) * 50,
      }));
      const created = await svc.createDelivery(
        {
          deliveryDate: day,
          driverId: pick(workers),
          customerId: c.id,
          items,
          vehicleId: vehicles.length > 0 ? pick(vehicles) : null,
          tripCount: 1 + Math.floor(random() * 2),
          deliveryFeeYen: random() < 0.5 ? null : 3000 + Math.floor(random() * 10) * 500,
        },
        ctx,
      );
      if (opts.confirm !== false) await svc.confirm('DELIVERY', created.id, created.version, ctx);
      reportNos.push(created.reportNo);
      delivery += 1;
    }
  }
  return { work, delivery, reportNos, days: workedDays };
}
