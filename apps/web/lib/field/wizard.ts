/**
 * SCR-03〜09 の step 検証と API body 生成（client/server 同一ルール: domain の検証関数を共用）。
 * 画面の入力値（文字列）→ step ごとの検証 → WorkDraft / DeliveryDraft。
 */
import {
  FIELD_QUANTITY_MAX,
  FIELD_WORKERS_MAX,
  jstToInstant,
  mergeDeliveryItems,
  validateDeliveryItems,
  validateWorkQuantities,
  validateWorkSpan,
  type FieldIssue,
} from '@inspexor/domain';

export interface DeliveryForm {
  deliveryDate: string;
  driverId: string;
  customerId: string;
  /** productId → 数量（文字列入力）。キーがあれば選択中 */
  items: Record<string, string>;
  /** CHG-004（提案書 P.7）: 使用車両（任意）・運搬回数・運搬費（任意・空欄で保存可） */
  vehicleId: string;
  tripCount: string;
  deliveryFee: string;
}

export interface WorkForm {
  workDate: string;
  reporterId: string;
  customerId: string;
  productId: string;
  workTypeId: string;
  lotNo: string;
  workerIds: string[];
  startTime: string;
  endTime: string;
  quantity: string;
  /** defectTypeId → 数量（文字列）。空/0 は送信しない */
  defects: Record<string, string>;
  /** CHG-004（提案書 P.8/P.9）: 作業場所・使用車（任意）・備考 */
  workLocationId: string;
  vehicleId: string;
  remarks: string;
  /** CHG-012 代理入力の理由（事務所が他の報告者で作成するとき） */
  proxyReason: string;
}

export const DELIVERY_FEE_MAX = 9_999_999;
export const TRIP_COUNT_MAX = 99;
export const REMARKS_MAX = 500;

export const DELIVERY_STEPS = ['基本情報', '品番・数量', '確認'] as const;
export const WORK_STEPS = ['基本', '製品・作業', '人員・時間', '数量・不良', '確認'] as const;

export function emptyDeliveryForm(today: string): DeliveryForm {
  return { deliveryDate: today, driverId: '', customerId: '', items: {}, vehicleId: '', tripCount: '1', deliveryFee: '' };
}

export function emptyWorkForm(today: string, reporterId: string): WorkForm {
  return { workDate: today, reporterId, customerId: '', productId: '', workTypeId: '', lotNo: '', workerIds: [], startTime: '', endTime: '', quantity: '', defects: {}, workLocationId: '', vehicleId: '', remarks: '', proxyReason: '' };
}

/** CHG-004 以前の端末下書き（新項目なし）を読み込んだときの補完 */
export function normalizeDeliveryForm(f: DeliveryForm): DeliveryForm {
  return { ...f, vehicleId: f.vehicleId ?? '', tripCount: f.tripCount ?? '1', deliveryFee: f.deliveryFee ?? '' };
}

export function normalizeWorkForm(f: WorkForm): WorkForm {
  return { ...f, workLocationId: f.workLocationId ?? '', vehicleId: f.vehicleId ?? '', remarks: f.remarks ?? '', proxyReason: f.proxyReason ?? '' };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d$/;

function intOf(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function required(issues: FieldIssue[], value: string, path: string, label: string): void {
  if (value.trim() === '') issues.push({ path, code: 'required', message: `${label}を選択または入力してください。` });
}

export interface MasterLookup {
  /** 有効な行のみを返す（無効・不存在は undefined） */
  readonly activeCustomer: (id: string) => boolean;
  readonly product: (id: string) => { customerId: string; lotRequired: boolean } | undefined;
  readonly workType: (id: string) => { productId: string } | undefined;
  readonly worker: (id: string) => boolean;
  readonly defectType: (id: string) => { productId: string } | undefined;
  readonly vehicle: (id: string) => boolean;
  readonly workLocation: (id: string) => boolean;
}

/** 運搬費（任意）: 空欄は null、整数 0〜9,999,999 */
export function feeOf(raw: string): number | null | 'invalid' {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return null;
  const n = intOf(t);
  return n === null || n > DELIVERY_FEE_MAX ? 'invalid' : n;
}

// ---------------------------------------------------------------- 運搬

export function validateDeliveryStep(step: number, f: DeliveryForm, m: MasterLookup): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (step >= 1) {
    if (!DATE_RE.test(f.deliveryDate)) issues.push({ path: '/deliveryDate', code: 'required', message: '運搬日を入力してください。' });
    required(issues, f.driverId, '/driverId', '運転者');
    if (f.driverId !== '' && !m.worker(f.driverId)) issues.push({ path: '/driverId', code: 'inactive', message: '運転者が無効です。選び直してください。' });
    required(issues, f.customerId, '/customerId', 'お客様');
    if (f.customerId !== '' && !m.activeCustomer(f.customerId)) issues.push({ path: '/customerId', code: 'inactive', message: 'お客様が無効です。選び直してください。' });
    if (f.vehicleId !== '' && !m.vehicle(f.vehicleId)) issues.push({ path: '/vehicleId', code: 'inactive', message: '使用車両が無効です。選び直してください。' });
  }
  if (step >= 2) {
    const trips = intOf(f.tripCount);
    if (trips === null || trips < 1 || trips > TRIP_COUNT_MAX) issues.push({ path: '/tripCount', code: 'range', message: `運搬回数は1〜${TRIP_COUNT_MAX}の整数で入力してください。` });
    if (feeOf(f.deliveryFee) === 'invalid') issues.push({ path: '/deliveryFeeYen', code: 'range', message: `運搬費は0〜${DELIVERY_FEE_MAX.toLocaleString('ja-JP')}円の整数で入力するか、空欄にしてください。` });
    const entries = Object.entries(f.items);
    if (entries.length === 0) issues.push({ path: '/items', code: 'required', message: '品番を1件以上選択してください。' });
    entries.forEach(([productId, raw]) => {
      const p = m.product(productId);
      if (p === undefined || p.customerId !== f.customerId) {
        issues.push({ path: `/items/${productId}/productId`, code: 'mismatch', message: '選択できない品番です。外してください。' });
      }
      const q = intOf(raw);
      if (q === null || q < 1 || q > FIELD_QUANTITY_MAX) {
        issues.push({ path: `/items/${productId}/quantity`, code: 'range', message: `数量は1〜${FIELD_QUANTITY_MAX.toLocaleString('ja-JP')}の整数で入力してください。` });
      }
    });
  }
  return issues;
}

export function buildDeliveryDraft(f: DeliveryForm): {
  deliveryDate: string;
  driverId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  vehicleId: string | null;
  tripCount: number;
  deliveryFeeYen: number | null;
} {
  const items = mergeDeliveryItems(Object.entries(f.items).map(([productId, raw]) => ({ productId, quantity: intOf(raw) ?? 0 })));
  const issues = validateDeliveryItems(items);
  if (issues.length > 0) throw new Error(issues[0]?.message);
  const fee = feeOf(f.deliveryFee);
  return {
    deliveryDate: f.deliveryDate,
    driverId: f.driverId,
    customerId: f.customerId,
    items,
    vehicleId: f.vehicleId === '' ? null : f.vehicleId,
    tripCount: intOf(f.tripCount) ?? 1,
    deliveryFeeYen: fee === 'invalid' ? null : fee,
  };
}

// ---------------------------------------------------------------- 作業

export function validateWorkStep(step: number, f: WorkForm, m: MasterLookup): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (step >= 1) {
    if (!DATE_RE.test(f.workDate)) issues.push({ path: '/workDate', code: 'required', message: '作業日を入力してください。' });
    required(issues, f.customerId, '/customerId', 'お客様');
    if (f.customerId !== '' && !m.activeCustomer(f.customerId)) issues.push({ path: '/customerId', code: 'inactive', message: 'お客様が無効です。選び直してください。' });
    if (f.workLocationId !== '' && !m.workLocation(f.workLocationId)) issues.push({ path: '/workLocationId', code: 'inactive', message: '作業場所が無効です。選び直してください。' });
  }
  if (step >= 2) {
    if (f.vehicleId !== '' && !m.vehicle(f.vehicleId)) issues.push({ path: '/vehicleId', code: 'inactive', message: '使用車が無効です。選び直してください。' });
    required(issues, f.productId, '/productId', '品番');
    const p = f.productId === '' ? undefined : m.product(f.productId);
    if (f.productId !== '' && (p === undefined || p.customerId !== f.customerId)) {
      issues.push({ path: '/productId', code: 'mismatch', message: '品番が選択したお客様のものではありません。' });
    }
    required(issues, f.workTypeId, '/workTypeId', '作業内容');
    const wt = f.workTypeId === '' ? undefined : m.workType(f.workTypeId);
    if (f.workTypeId !== '' && (wt === undefined || wt.productId !== f.productId)) {
      issues.push({ path: '/workTypeId', code: 'mismatch', message: '作業内容を選び直してください。' });
    }
    if (f.lotNo.length > 100) issues.push({ path: '/lotNo', code: 'too_long', message: 'ロット番号は100文字以内です。' });
    if (p?.lotRequired === true && f.lotNo.trim() === '') issues.push({ path: '/lotNo', code: 'required', message: 'この品番はロット番号の入力が必須です。' });
  }
  if (step >= 3) {
    if (f.workerIds.length === 0) issues.push({ path: '/workerIds', code: 'required', message: '作業者を1名以上選択してください。' });
    if (f.workerIds.length > FIELD_WORKERS_MAX) issues.push({ path: '/workerIds', code: 'range', message: `作業者は${FIELD_WORKERS_MAX}名までです。` });
    f.workerIds.forEach((id) => {
      if (!m.worker(id)) issues.push({ path: '/workerIds', code: 'inactive', message: '無効な作業者が含まれています。外してください。' });
    });
    if (!TIME_RE.test(f.startTime)) issues.push({ path: '/startAt', code: 'required', message: '開始時刻を入力してください。' });
    if (!TIME_RE.test(f.endTime)) issues.push({ path: '/endAt', code: 'required', message: '終了時刻を入力してください。' });
    if (TIME_RE.test(f.startTime) && TIME_RE.test(f.endTime) && DATE_RE.test(f.workDate)) {
      const span = validateWorkSpan(f.workDate, new Date(startInstant(f)), new Date(endInstant(f)));
      if (!span.ok) issues.push(...span.issues);
    }
  }
  if (step >= 4) {
    const q = intOf(f.quantity);
    if (q === null) {
      issues.push({ path: '/quantity', code: 'required', message: '数量を0以上の整数で入力してください。' });
    } else {
      const defects: Array<{ defectTypeId: string; quantity: number }> = [];
      Object.entries(f.defects).forEach(([defectTypeId, raw]) => {
        if (raw.trim() === '') return;
        const dq = intOf(raw);
        if (dq === null) {
          issues.push({ path: `/defects/${defectTypeId}`, code: 'type', message: '不良数は0以上の整数で入力してください。' });
          return;
        }
        const dt = m.defectType(defectTypeId);
        if (dt === undefined || dt.productId !== f.productId) {
          issues.push({ path: `/defects/${defectTypeId}`, code: 'mismatch', message: '選択できない不良種別です。' });
        }
        defects.push({ defectTypeId, quantity: dq });
      });
      issues.push(...validateWorkQuantities({ quantity: q, workerIds: f.workerIds, defects }));
    }
    if (f.remarks.length > REMARKS_MAX) issues.push({ path: '/remarks', code: 'too_long', message: `備考は${REMARKS_MAX}文字以内です。` });
  }
  return issues.filter((issue, i, all) => all.findIndex((x) => x.path === issue.path && x.code === issue.code) === i);
}

function startInstant(f: WorkForm): string {
  return jstToInstant(f.workDate, f.startTime);
}

function endInstant(f: WorkForm): string {
  return jstToInstant(f.workDate, f.endTime === '00:00' ? '24:00' : f.endTime);
}

export function buildWorkDraft(f: WorkForm, selfId?: string) {
  return {
    workDate: f.workDate,
    reporterId: f.reporterId,
    customerId: f.customerId,
    productId: f.productId,
    workTypeId: f.workTypeId,
    lotNo: f.lotNo.trim() === '' ? null : f.lotNo.trim(),
    workerIds: [...f.workerIds],
    startAt: startInstant(f),
    endAt: endInstant(f),
    quantity: intOf(f.quantity) ?? 0,
    defects: Object.entries(f.defects)
      .map(([defectTypeId, raw]) => ({ defectTypeId, quantity: intOf(raw) ?? 0 }))
      .filter((d) => d.quantity > 0),
    workLocationId: f.workLocationId === '' ? null : f.workLocationId,
    vehicleId: f.vehicleId === '' ? null : f.vehicleId,
    remarks: f.remarks.trim() === '' ? null : f.remarks.trim(),
    // CHG-012 代理入力（作成時だけ送る。更新では useWizard が外す）
    ...(selfId !== undefined && f.reporterId !== selfId ? { proxyReason: f.proxyReason.trim() } : {}),
  };
}

/** server 応答（Detail）→ 画面入力値（競合時の再読込・下書き再開用） */
export function workDetailToForm(d: Record<string, unknown>, toJstTime: (iso: string) => { date: string; time: string }): WorkForm {
  const start = toJstTime(d['startAt'] as string);
  const end = toJstTime(d['endAt'] as string);
  return {
    workDate: d['workDate'] as string,
    reporterId: d['reporterId'] as string,
    customerId: d['customerId'] as string,
    productId: d['productId'] as string,
    workTypeId: d['workTypeId'] as string,
    lotNo: (d['lotNo'] as string | null) ?? '',
    workerIds: d['workerIds'] as string[],
    startTime: start.time,
    // 終了 24:00（翌日0:00）は time 入力で表せないため '00:00' で保持し、送信時に 24:00 として扱う
    endTime: end.time,
    quantity: String(d['quantity']),
    defects: Object.fromEntries((d['defects'] as Array<{ defectTypeId: string; quantity: number }>).map((x) => [x.defectTypeId, String(x.quantity)])),
    workLocationId: (d['workLocationId'] as string | null) ?? '',
    vehicleId: (d['vehicleId'] as string | null) ?? '',
    remarks: (d['remarks'] as string | null) ?? '',
    proxyReason: '',
  };
}

export function deliveryDetailToForm(d: Record<string, unknown>): DeliveryForm {
  return {
    deliveryDate: d['deliveryDate'] as string,
    driverId: d['driverId'] as string,
    customerId: d['customerId'] as string,
    items: Object.fromEntries((d['items'] as Array<{ productId: string; quantity: number }>).map((i) => [i.productId, String(i.quantity)])),
    vehicleId: (d['vehicleId'] as string | null) ?? '',
    tripCount: String((d['tripCount'] as number | undefined) ?? 1),
    deliveryFee: d['deliveryFeeYen'] === null || d['deliveryFeeYen'] === undefined ? '' : String(d['deliveryFeeYen']),
  };
}

/** server の 422 fields.path → その項目を入力する step */
export function stepOfPath(type: 'work' | 'delivery', path: string): number {
  const key = path.split('/')[1] ?? '';
  if (type === 'delivery') return ['deliveryDate', 'driverId', 'customerId', 'vehicleId'].includes(key) ? 1 : 2;
  if (['workDate', 'reporterId', 'proxyReason', 'customerId', 'workLocationId'].includes(key)) return 1;
  if (['productId', 'workTypeId', 'lotNo', 'vehicleId'].includes(key)) return 2;
  if (['workerIds', 'startAt', 'endAt'].includes(key)) return 3;
  return 4;
}

/** CHG-012 代理入力の理由の検証（報告者が本人以外のとき必須） */
export function validateProxy(f: WorkForm, selfId: string): FieldIssue[] {
  if (f.reporterId === selfId) return [];
  const r = f.proxyReason.trim();
  if (r === '') return [{ path: '/proxyReason', code: 'required', message: '代理入力の理由を入力してください。' }];
  if (r.length > 500) return [{ path: '/proxyReason', code: 'too_big', message: '代理入力の理由は500文字以内で入力してください。' }];
  return [];
}
