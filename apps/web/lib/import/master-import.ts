/**
 * CHG-013 マスタ・利用者の一括登録（Excel の各シート → 確認 → 登録・更新）。
 *
 *  - シートの列は日本語の見出し。親（お客様・品番・作業内容）はコードで書き、取込時に ID に置き換える
 *  - 登録・更新は画面と同じ MasterService を通す（入力規則・一意・期間の重なり・監査が同じ）
 *  - 既にある行（コード、期間ルールは「品番＋作業内容＋適用開始」など）は、内容が違えば更新（理由付き）、同じなら何もしない
 *  - 確認（dryRun）では書き込まず、行ごとに「追加・更新・変更なし・エラー」を返す。エラーが1件でもあれば登録しない
 *  - 削除はしない（使わなくなったものは「有効」列を × にする＝無効化）
 *  - 利用者は追加のみ（既存は変更しない）。初期パスワードは呼び出し側がファイルに保存する（画面・記録に出さない）
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createUser, readUniqueOwner, C, type DocStore, type UserDoc } from '@inspexor/docstore';
import { MasterService, MasterError } from '../masters/master-service';
import { MASTER_DEFS, type MasterType } from '../masters/definitions';
import { updateSchema, writeSchema } from '../masters/schemas';

export type Cell = string | number | boolean | Date | null | undefined;
export type SheetRows = ReadonlyArray<Readonly<Record<string, Cell>>>;
export type Workbook = Readonly<Record<string, SheetRows>>;

type ColKind = 'text' | 'int' | 'bool' | 'date' | 'decimal' | 'enum' | 'codes';
interface Column {
  readonly header: string;
  /** API 項目（親の参照列は無し） */
  readonly api?: string;
  readonly kind: ColKind;
  readonly required?: boolean;
  /** enum の表示 → 値 */
  readonly values?: Readonly<Record<string, string>>;
  /** 参照列（お客様コード・品番・作業内容コード） */
  readonly ref?: 'customer' | 'product' | 'workType';
  readonly note: string;
  readonly example: Cell;
}

export interface SheetSpec {
  readonly sheet: string;
  readonly type: MasterType | 'users';
  readonly columns: readonly Column[];
  readonly note: string;
}

const ACTIVE: Column = { header: '有効', api: 'active', kind: 'bool', note: '○＝有効（空欄も有効）、×＝無効', example: '○' };
const CUSTOMER: Column = { header: 'お客様コード', kind: 'text', required: true, ref: 'customer', note: '「お客様」シートのコード', example: 'TEST-C01' };
const PRODUCT: Column = { header: '品番', kind: 'text', required: true, ref: 'product', note: '「品番」シートの品番（お客様コードと組で指定）', example: 'TEST-P01' };
const FROM: Column = { header: '適用開始', api: 'validFrom', kind: 'date', required: true, note: '日付（例 2026/12/01）', example: '2026/12/01' };
const TO: Column = { header: '適用終了', api: 'validTo', kind: 'date', note: '日付。空欄＝期限なし', example: '' };

/** 記入順（親が先） */
export const SHEETS: readonly SheetSpec[] = [
  {
    sheet: 'お客様',
    type: 'customers',
    note: 'コードは英数字・記号（30文字まで）。締め日は 1〜31（月末は 31 または「末」）',
    columns: [
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '一意。あとから変えない', example: 'TEST-C01' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '帳票の宛名（「御中」は付けない）', example: '試験用 株式会社サンプル' },
      { header: '締め日', api: 'closingDay', kind: 'int', required: true, note: '1〜31、月末は 31 または「末」', example: '末' },
      ACTIVE,
    ],
  },
  {
    sheet: '品番',
    type: 'products',
    note: 'お客様ごとに品番は一意',
    columns: [
      CUSTOMER,
      { header: '品番', api: 'code', kind: 'text', required: true, note: '80文字まで', example: 'TEST-P01' },
      { header: '品名', api: 'name', kind: 'text', required: true, note: '200文字まで', example: '試験用 ブラケット' },
      { header: '精算区分', api: 'settlementType', kind: 'enum', required: true, values: { 数量: 'QUANTITY', 時間: 'TIME', QUANTITY: 'QUANTITY', TIME: 'TIME' }, note: '数量 または 時間', example: '数量' },
      { header: 'ロット必須', api: 'lotRequired', kind: 'bool', note: '○＝作業日報でロット番号を必須にする', example: '×' },
      ACTIVE,
    ],
  },
  {
    sheet: '作業内容',
    type: 'work-types',
    note: '品番ごとの作業内容（検査・バリ取り など）',
    columns: [
      CUSTOMER,
      PRODUCT,
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '品番ごとに一意（50文字まで）', example: 'INSP' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '', example: '外観検査' },
      ACTIVE,
    ],
  },
  {
    sheet: '不良種別',
    type: 'defects',
    note: '品番ごとの不良の種類。表示順の小さいものから画面に並ぶ',
    columns: [
      CUSTOMER,
      PRODUCT,
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '品番ごとに一意', example: 'D01' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '', example: 'バリ' },
      { header: '表示順', api: 'sortOrder', kind: 'int', required: true, note: '0 以上の整数', example: 1 },
      ACTIVE,
    ],
  },
  {
    sheet: '作業者',
    type: 'workers',
    note: '作業者・運転者として選ぶ名前（ログインする利用者とは別）',
    columns: [
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '一意', example: 'TEST-W01' },
      { header: '氏名', api: 'name', kind: 'text', required: true, note: '', example: '試験 太郎' },
      ACTIVE,
    ],
  },
  {
    sheet: '車両',
    type: 'vehicles',
    note: '運搬実績・作業日報で選ぶ車両',
    columns: [
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '一意', example: 'TEST-V01' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '', example: '試験用 2t トラック' },
      ACTIVE,
    ],
  },
  {
    sheet: '作業場所',
    type: 'work-locations',
    note: '作業日報で選ぶ作業場所',
    columns: [
      { header: 'コード', api: 'code', kind: 'text', required: true, note: '一意', example: 'TEST-L01' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '', example: '試験用 第1工場' },
      ACTIVE,
    ],
  },
  {
    sheet: 'お客様担当者',
    type: 'contacts',
    note: '日報・請求書の送付先（メール送信は既定で無効）。担当品番を空欄にすると全品番',
    columns: [
      CUSTOMER,
      { header: 'コード', api: 'code', kind: 'text', required: true, note: 'お客様ごとに一意', example: 'K01' },
      { header: '氏名', api: 'name', kind: 'text', required: true, note: '', example: '試験 花子' },
      { header: 'メール', api: 'email', kind: 'text', required: true, note: '', example: 'test-contact@example.com' },
      { header: '日報メール', api: 'sendDaily', kind: 'bool', note: '○＝日報の送付先', example: '×' },
      { header: '請求書メール', api: 'sendInvoice', kind: 'bool', note: '○＝請求書の送付先', example: '×' },
      { header: '日報の担当品番', api: 'dailyProductIds', kind: 'codes', note: '品番をカンマ区切り。空欄＝全品番', example: '' },
      { header: '請求書の担当品番', api: 'invoiceProductIds', kind: 'codes', note: '品番をカンマ区切り。空欄＝全品番', example: '' },
      ACTIVE,
    ],
  },
  {
    sheet: '休日',
    type: 'holidays',
    note: '土日以外の休日（祝日・会社休日）。この日の作業は全時間が時間外',
    columns: [
      { header: '日付', api: 'holidayDate', kind: 'date', required: true, note: '例 2026/12/30', example: '2026/12/30' },
      { header: '名称', api: 'name', kind: 'text', required: true, note: '', example: '年末休業' },
      ACTIVE,
    ],
  },
  {
    sheet: '単価',
    type: 'rates',
    note: '（請求機能を使うときだけ）作業単価。作業内容コードを空欄にすると品番の全作業',
    columns: [
      CUSTOMER,
      PRODUCT,
      { header: '作業内容コード', kind: 'text', ref: 'workType', note: '空欄＝品番の全作業', example: '' },
      { header: '単価', api: 'unitPrice', kind: 'decimal', required: true, note: '円（小数4桁まで）', example: '4.4' },
      { header: '割増率', api: 'overtimeMultiplier', kind: 'decimal', note: '空欄＝1.25', example: '' },
      FROM,
      TO,
      ACTIVE,
    ],
  },
  {
    sheet: '運搬ルール',
    type: 'transport-rules',
    note: '（請求機能を使うときだけ）運搬費の計算方法',
    columns: [
      CUSTOMER,
      PRODUCT,
      { header: '作業内容コード', kind: 'text', ref: 'workType', note: '空欄＝品番の全作業', example: '' },
      { header: '区分', api: 'transportType', kind: 'enum', required: true, values: { 按分: 'ALLOCATED', 便ごと: 'PER_TRIP', 月額: 'MONTHLY_FIXED', なし: 'NONE', ALLOCATED: 'ALLOCATED', PER_TRIP: 'PER_TRIP', MONTHLY_FIXED: 'MONTHLY_FIXED', NONE: 'NONE' }, note: '按分・便ごと・月額・なし', example: '按分' },
      { header: '金額', api: 'amountYen', kind: 'int', required: true, note: '円', example: 2500 },
      { header: '按分グループ', api: 'allocationGroup', kind: 'text', note: '空欄可', example: '' },
      FROM,
      TO,
      ACTIVE,
    ],
  },
  {
    sheet: '固定費',
    type: 'fixed-charges',
    note: '（請求機能を使うときだけ）毎月の固定費（保管料など）',
    columns: [
      CUSTOMER,
      PRODUCT,
      { header: '名称', api: 'label', kind: 'text', required: true, note: '', example: '保管料' },
      { header: '金額', api: 'amountYen', kind: 'int', required: true, note: '円', example: 5000 },
      FROM,
      TO,
      ACTIVE,
    ],
  },
  {
    sheet: '利用者',
    type: 'users',
    note: 'ログインする人。追加のみ（既にあるログインIDは変更しない）。初期パスワードは取込時にファイルへ出力',
    columns: [
      { header: 'ログインID', kind: 'text', required: true, note: '3〜100文字の英数字と . _ @ -', example: 'test.field01' },
      { header: '表示名', kind: 'text', required: true, note: '', example: '試験 現場一郎' },
      { header: '区分', kind: 'text', required: true, note: '現場・事務・管理者・監査（複数はカンマ区切り）', example: '現場' },
    ],
  },
];

export type RowAction = 'create' | 'update' | 'same' | 'error';
export interface RowResult {
  readonly sheet: string;
  /** Excel の行番号（見出しが1行目） */
  readonly row: number;
  readonly key: string;
  readonly action: RowAction;
  readonly messages: readonly string[];
}

export interface ImportResult {
  readonly applied: boolean;
  readonly rows: readonly RowResult[];
  readonly counts: Readonly<Record<RowAction, number>>;
  /** 追加した利用者の初期パスワード（apply のときだけ。呼び出し側がファイルに保存する） */
  readonly passwords: ReadonlyArray<{ loginId: string; displayName: string; roles: string; password: string }>;
}

export interface ImportOptions {
  readonly apply: boolean;
  readonly actorId: string;
  readonly reason: string;
  readonly now: Date;
  /** 試験: パスワードのハッシュ化（既定は呼び出し側が argon2 を渡す） */
  readonly hashPassword: (plain: string) => Promise<string>;
}

const ROLE_MAP: Readonly<Record<string, string>> = { 現場: 'FIELD', 事務: 'OFFICE', 事務所: 'OFFICE', 管理者: 'ADMIN', 監査: 'AUDITOR', FIELD: 'FIELD', OFFICE: 'OFFICE', ADMIN: 'ADMIN', AUDITOR: 'AUDITOR' };

function str(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return dateText(v);
  return String(v).trim();
}

function dateText(d: Date): string {
  // Excel の日付は UTC の 0 時として読まれる
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

class CellError extends Error {}

function convert(col: Column, raw: Cell): unknown {
  const s = str(raw);
  if (s === '') {
    if (col.required) throw new CellError(`「${col.header}」を入力してください。`);
    return undefined;
  }
  switch (col.kind) {
    case 'text':
      return s;
    case 'int': {
      if (col.api === 'closingDay' && (s === '末' || s === '月末')) return 31;
      const n = typeof raw === 'number' ? raw : Number(s.replace(/,/g, ''));
      if (!Number.isInteger(n)) throw new CellError(`「${col.header}」は整数で入力してください（${s}）。`);
      return n;
    }
    case 'decimal': {
      const t = typeof raw === 'number' ? String(raw) : s.replace(/,/g, '');
      if (!/^\d+(\.\d+)?$/.test(t)) throw new CellError(`「${col.header}」は数値で入力してください（${s}）。`);
      return t;
    }
    case 'bool': {
      if (raw === true || ['○', '〇', 'はい', 'TRUE', 'true', '1', 'yes', 'YES'].includes(s)) return true;
      if (raw === false || ['×', 'いいえ', 'FALSE', 'false', '0', 'no', 'NO', '-', '－'].includes(s)) return false;
      throw new CellError(`「${col.header}」は ○ または × で入力してください（${s}）。`);
    }
    case 'date': {
      if (raw instanceof Date) return dateText(raw);
      const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
      if (m === null) throw new CellError(`「${col.header}」は日付（例 2026/12/01）で入力してください（${s}）。`);
      return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    }
    case 'enum': {
      const v = col.values?.[s];
      if (v === undefined) throw new CellError(`「${col.header}」は ${Object.keys(col.values ?? {}).filter((k) => !/^[A-Z_]+$/.test(k)).join('・')} のどれかです（${s}）。`);
      return v;
    }
    case 'codes':
      return s
        .split(/[,、，\s]+/)
        .map((x) => x.trim())
        .filter((x) => x !== '');
  }
}

/** 既存の行・今回追加する行の ID（コード → ID） */
class Registry {
  private readonly ids = new Map<string, string>();
  constructor(private readonly store: DocStore) {}
  set(kind: string, scope: string, code: string, id: string): void {
    this.ids.set(`${kind}|${scope}|${code}`, id);
  }
  async get(kind: 'customers' | 'products' | 'work-types', scope: string, code: string): Promise<string | null> {
    const k = `${kind}|${scope}|${code}`;
    const hit = this.ids.get(k);
    if (hit !== undefined) return hit;
    const id = await readUniqueOwner(this.store, `master:${kind}`, scope, code.normalize('NFKC'));
    if (id !== null) this.ids.set(k, id);
    return id;
  }
}

/** 期間ルール（単価・運搬・固定費）の既存行を探す: 重なり判定の項目＋適用開始が同じもの */
async function findRule(store: DocStore, type: MasterType, input: Record<string, unknown>): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const def = MASTER_DEFS[type];
  const rows = await store.query<Record<string, unknown>>(def.collection, { where: [{ field: 'productId', op: '==', value: input['productId'] as string }] });
  const keys = [...(def.overlapKeys ?? []), 'validFrom'];
  const hit = rows.find((r) => keys.every((k) => (r.data[k] ?? null) === (input[k] ?? null)));
  return hit === undefined ? null : { id: hit.id, data: hit.data };
}

/** 期間ルールの重なり（有効なルールどうしで、重なり判定の項目が同じで適用期間が重なる）。確認の段階で見つける */
async function overlapping(store: DocStore, type: MasterType, input: Record<string, unknown>, excludeId: string | null): Promise<boolean> {
  const def = MASTER_DEFS[type];
  if ((input['active'] ?? true) === false) return false;
  const rows = await store.query<Record<string, unknown>>(def.collection, { where: [{ field: 'productId', op: '==', value: input['productId'] as string }] });
  const from = String(input['validFrom']);
  const to = (input['validTo'] as string | null | undefined) ?? '9999-12-31';
  return rows.some(
    (r) =>
      r.id !== excludeId &&
      r.data['active'] !== false &&
      (def.overlapKeys ?? []).every((k) => (r.data[k] ?? null) === (input[k] ?? null)) &&
      String(r.data['validFrom']) <= to &&
      from <= String(r.data['validTo'] ?? '9999-12-31'),
  );
}

/** 既存の値と比べて違いがあるか（期間ルールの日付・配列も比べる） */
function changed(def: (typeof MASTER_DEFS)[MasterType], current: Record<string, unknown>, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of def.fields) {
    const a = current[f.api] ?? null;
    const b = input[f.api] ?? null;
    const norm = (v: unknown) => (Array.isArray(v) ? JSON.stringify([...v].sort()) : v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v));
    if (norm(a) !== norm(b)) out.push(f.api);
  }
  return out;
}

export function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = randomBytes(16);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

/** 取込（apply=false は確認だけ）。apply でもエラーが1件でもあれば何も書き込まない */
export async function importWorkbook(store: DocStore, book: Workbook, options: ImportOptions): Promise<ImportResult> {
  const plan = await run(store, book, { ...options, apply: false });
  if (!options.apply || plan.counts.error > 0) return plan;
  return run(store, book, options);
}

async function run(store: DocStore, book: Workbook, options: ImportOptions): Promise<ImportResult> {
  const service = new MasterService(store, { billing: true });
  const registry = new Registry(store);
  const ctx = { actorId: options.actorId, correlationId: randomUUID(), now: options.now };
  const rows: RowResult[] = [];
  const passwords: Array<{ loginId: string; displayName: string; roles: string; password: string }> = [];
  const seenKeys = new Set<string>();

  for (const spec of SHEETS) {
    const sheetRows = book[spec.sheet];
    if (sheetRows === undefined) continue;
    for (const [i, raw] of sheetRows.entries()) {
      const rowNo = i + 2;
      if (spec.columns.every((c) => str(raw[c.header]) === '')) continue;
      const messages: string[] = [];
      const values: Record<string, unknown> = {};
      const refs: Record<string, string> = {};
      for (const col of spec.columns) {
        try {
          const v = convert(col, raw[col.header]);
          if (col.ref !== undefined) refs[col.ref] = (v as string | undefined) ?? '';
          else if (col.api !== undefined && v !== undefined) values[col.api] = v;
          else if (col.api === undefined && v !== undefined) refs[col.header] = v as string;
        } catch (e) {
          if (e instanceof CellError) messages.push(e.message);
          else throw e;
        }
      }
      const fail = (key: string, msgs: string[]) => rows.push({ sheet: spec.sheet, row: rowNo, key, action: 'error', messages: msgs });

      // ---- 利用者
      if (spec.type === 'users') {
        const loginId = refs['ログインID'] ?? '';
        const roleText = refs['区分'] ?? '';
        const roles = [...new Set(roleText.split(/[,、，\s]+/).filter((x) => x !== '').map((r) => ROLE_MAP[r] ?? `?${r}`))];
        if (roles.some((r) => r.startsWith('?'))) messages.push(`「区分」は 現場・事務・管理者・監査 のどれかです（${roleText}）。`);
        if (loginId !== '' && !/^[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$/.test(loginId)) messages.push('「ログインID」は3〜100文字の英数字と . _ @ - で入力してください。');
        if (seenKeys.has(`users|${loginId}`)) messages.push('同じログインIDが2回あります。');
        seenKeys.add(`users|${loginId}`);
        if (messages.length > 0) {
          fail(loginId, messages);
          continue;
        }
        const existing = await readUniqueOwner(store, 'login', '-', loginId);
        if (existing !== null) {
          const u = await store.get<UserDoc>(`${C.users}/${existing}`);
          rows.push({ sheet: spec.sheet, row: rowNo, key: loginId, action: 'same', messages: [u !== null && [...u.roles].sort().join(',') !== [...roles].sort().join(',') ? '既にあります（区分が違います。区分は利用者管理の画面で変更してください）' : '既にあります（変更しません）'] });
          continue;
        }
        if (options.apply) {
          const password = generatePassword();
          const id = await createUser(store, { loginId, passwordHash: await options.hashPassword(password), displayName: refs['表示名'] ?? '', roles }, options.now);
          if (id === null) {
            fail(loginId, ['同時に作成されました（もう一度確認してください）。']);
            continue;
          }
          passwords.push({ loginId, displayName: refs['表示名'] ?? '', roles: roleText, password });
        }
        rows.push({ sheet: spec.sheet, row: rowNo, key: loginId, action: 'create', messages: [] });
        continue;
      }

      // ---- マスタ
      const type = spec.type;
      const def = MASTER_DEFS[type];
      // 親の参照（コード → ID）
      let customerId: string | null = null;
      if (refs['customer'] !== undefined) {
        customerId = refs['customer'] === '' ? null : await registry.get('customers', '-', refs['customer']);
        if (customerId === null && refs['customer'] !== '') messages.push(`お客様コード「${refs['customer']}」がありません（「お客様」シートか登録済みのお客様）。`);
        if (type === 'contacts' && customerId !== null) values['customerId'] = customerId;
        if (type === 'products' && customerId !== null) values['customerId'] = customerId;
      }
      let productId: string | null = null;
      if (refs['product'] !== undefined && customerId !== null) {
        productId = await registry.get('products', customerId, refs['product']);
        if (productId === null) messages.push(`品番「${refs['product']}」がお客様「${refs['customer']}」にありません。`);
        else values['productId'] = productId;
      }
      if (refs['workType'] !== undefined) {
        if (refs['workType'] === '') values['workTypeId'] = null;
        else if (productId !== null) {
          const wt = await registry.get('work-types', productId, refs['workType']);
          if (wt === null) messages.push(`作業内容コード「${refs['workType']}」が品番「${refs['product']}」にありません。`);
          else values['workTypeId'] = wt;
        }
      }
      if (type === 'contacts' && customerId !== null) {
        for (const k of ['dailyProductIds', 'invoiceProductIds'] as const) {
          const codes = (values[k] as string[] | undefined) ?? [];
          const ids: string[] = [];
          for (const c of codes) {
            const pid = await registry.get('products', customerId, c);
            if (pid === null) messages.push(`担当品番「${c}」がお客様「${refs['customer']}」にありません。`);
            else ids.push(pid);
          }
          values[k] = ids;
        }
      }
      const parsed = writeSchema(def).safeParse(values);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const col = spec.columns.find((c) => c.api === String(issue.path[0]));
          if (col !== undefined || issue.path.length === 0) messages.push(`「${col?.header ?? '行'}」${issue.message}`);
        }
      }
      const input = parsed.success ? (parsed.data as Record<string, unknown>) : values;
      const scope = def.uniqueScope === null ? '-' : String(input[def.uniqueScope] ?? '');
      const keyParts = def.overlapKeys !== undefined
        ? [refs['customer'], refs['product'], refs['workType'], input['label'] as string | undefined, input['transportType'] as string | undefined, input['validFrom'] as string | undefined]
        : [refs['customer'], refs['product'], String(input[def.uniqueField] ?? '')];
      const key = keyParts.filter((x): x is string => x !== undefined && x !== '').join('/');
      const dupKey = `${type}|${scope}|${key}`;
      if (seenKeys.has(dupKey)) messages.push('同じシートに同じキーの行が2回あります。');
      seenKeys.add(dupKey);
      if (messages.length > 0) {
        fail(key, messages);
        continue;
      }

      // 既存を探す
      let existing: { id: string; data: Record<string, unknown> } | null;
      if (def.overlapKeys !== undefined) existing = await findRule(store, type, input);
      else {
        const id = await readUniqueOwner(store, `master:${type}`, scope, String(input[def.uniqueField]));
        existing = id === null ? null : { id, data: (await store.get<Record<string, unknown>>(`${def.collection}/${id}`)) ?? {} };
      }
      if (def.overlapKeys !== undefined && (await overlapping(store, type, input, existing?.id ?? null))) {
        fail(key, ['適用期間が、同じ品番・作業内容の有効なルールと重なっています（先に既存のルールの「適用終了」を設定してください）。']);
        continue;
      }
      try {
        if (existing === null) {
          const id = options.apply ? (await service.create(type, input, ctx)).id : randomUUID();
          if (type === 'customers' || type === 'products' || type === 'work-types') registry.set(type, scope, String(input[def.uniqueField]), id);
          rows.push({ sheet: spec.sheet, row: rowNo, key, action: 'create', messages: [] });
        } else {
          if (type === 'customers' || type === 'products' || type === 'work-types') registry.set(type, scope, String(input[def.uniqueField]), existing.id);
          const diff = changed(def, existing.data, input);
          if (diff.length === 0) {
            rows.push({ sheet: spec.sheet, row: rowNo, key, action: 'same', messages: [] });
            continue;
          }
          if (options.apply) {
            const upd = updateSchema(def).parse({ ...input, expectedVersion: existing.data['version'], reason: options.reason });
            await service.update(type, existing.id, upd as Record<string, unknown>, ctx, false);
          }
          const labels = diff.map((a) => spec.columns.find((c) => c.api === a)?.header ?? a);
          rows.push({ sheet: spec.sheet, row: rowNo, key, action: 'update', messages: [`変更: ${labels.join('・')}`] });
        }
      } catch (e) {
        if (e instanceof MasterError) fail(key, [e.message, ...(e.fields ?? []).map((f) => f.message)]);
        else throw e;
      }
    }
  }
  const counts: Record<RowAction, number> = { create: 0, update: 0, same: 0, error: 0 };
  for (const r of rows) counts[r.action] += 1;
  return { applied: options.apply, rows, counts, passwords };
}
