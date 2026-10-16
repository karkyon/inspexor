/**
 * CHG-013 結合試験: マスタ・利用者の一括登録（Excel テンプレート → 読込 → 確認 → 登録 → 再実行で変更なし → 更新 → エラー時は書き込まない）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { auditEventsFor, C, createUser, readUniqueOwner, type UserDoc } from '@inspexor/docstore';
import { createTestStore, type TestStore } from '@inspexor/docstore/testing';
import { importWorkbook, SHEETS, type Workbook } from './master-import';
import { readWorkbook, SAMPLE_DATA, writeTemplate } from './xlsx';

const NOW = new Date('2026-10-16T00:00:00Z');
let t: TestStore;
let actorId = '';
const opts = (apply: boolean) => ({ apply, actorId, reason: '一括登録（試験）', now: NOW, hashPassword: async (p: string) => `hash:${p.length}` });

beforeAll(async () => {
  t = createTestStore('import');
  actorId = (await createUser(t.store, { loginId: 'imp-admin', passwordHash: 'x', displayName: '管理者', roles: ['ADMIN'] }, NOW)) as string;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function idOf(kind: string, scope: string, code: string): Promise<string> {
  return (await readUniqueOwner(t.store, `master:${kind}`, scope, code)) as string;
}

describe('CHG-013 マスタ・利用者の一括登録', () => {
  it('テンプレート: 記入方法と全シート（見出しに必須の印）、試験用データ一式は TEST- で始まる', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await writeTemplate(false)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['記入方法', ...SHEETS.map((s) => s.sheet)]);
    expect(wb.getWorksheet('品番')?.getRow(1).getCell(1).value).toBe('お客様コード（必須）');
    expect(wb.getWorksheet('品番')?.getRow(2).getCell(1).value ?? null).toBeNull();
    for (const rows of Object.values(SAMPLE_DATA)) for (const r of rows) for (const k of ['コード', '品番', 'お客様コード']) if (r[k] !== undefined && /^[A-Z]/.test(String(r[k])) && String(r[k]).length > 4 && !['INSP', 'DEBR'].includes(String(r[k]))) expect(String(r[k])).toMatch(/^TEST-/);
  });

  it('試験用データ一式: 確認（書き込まない）→ 登録 → 親はコードから ID に置き換わる → 利用者の初期パスワード → 監査', async () => {
    const book = await readWorkbook(await writeTemplate(true));
    const plan = await importWorkbook(t.store, book, opts(false));
    expect(plan.counts.error, JSON.stringify(plan.rows.filter((r) => r.action === 'error'))).toBe(0);
    const expected = Object.values(SAMPLE_DATA).reduce((n, rows) => n + rows.length, 0);
    expect(plan.counts.create).toBe(expected);
    expect(plan.applied).toBe(false);
    expect(await idOf('customers', '-', 'TEST-C01')).toBeNull();

    const done = await importWorkbook(t.store, book, opts(true));
    expect(done).toMatchObject({ applied: true, counts: { create: expected, update: 0, error: 0 } });
    const c1 = await idOf('customers', '-', 'TEST-C01');
    const a200 = await idOf('products', c1, 'TEST-A200');
    expect((await t.store.get<Record<string, unknown>>(`${C.products}/${a200}`))).toMatchObject({ customerId: c1, lotRequired: true, settlementType: 'QUANTITY' });
    expect(await t.store.get<Record<string, unknown>>(`${C.customers}/${c1}`)).toMatchObject({ closingDay: 31 });
    const c2 = await idOf('customers', '-', 'TEST-C02');
    const b100 = await idOf('products', c2, 'TEST-B100');
    const contacts = await t.store.query<Record<string, unknown>>(C.customerContacts, { where: [{ field: 'customerId', op: '==', value: c2 }] });
    expect(contacts[0]?.data).toMatchObject({ dailyProductIds: [b100], invoiceProductIds: [], email: 'test-contact-b@example.com' });
    // 利用者: パスワードはハッシュのみ保存、平文は結果（呼び出し側がファイルへ）
    expect(done.passwords.map((p) => p.loginId)).toEqual(['test.field01', 'test.field02', 'test.office01']);
    const uid = await readUniqueOwner(t.store, 'login', '-', 'test.office01');
    const u = (await t.store.get<UserDoc>(`${C.users}/${uid}`)) as UserDoc;
    expect(u).toMatchObject({ roles: ['OFFICE'], passwordHash: `hash:${done.passwords[2]?.password.length}` });
    expect(JSON.stringify(u)).not.toContain(done.passwords[2]?.password as string);
    expect((await auditEventsFor(t.store, 'MASTER:products', a200)).map((a) => a.action)).toEqual(['MASTER_CREATE']);
  });

  it('同じ Excel をもう一度取り込むと、すべて変更なし（何度実行しても同じ状態）', async () => {
    const r = await importWorkbook(t.store, await readWorkbook(await writeTemplate(true)), opts(true));
    expect(r.counts).toMatchObject({ create: 0, update: 0, error: 0 });
    expect(r.passwords).toEqual([]);
  });

  it('内容を変えた行は更新（理由付きで監査）、追加した行は追加。「有効」× は無効化', async () => {
    const book = (await readWorkbook(await writeTemplate(true))) as Record<string, Array<Record<string, unknown>>>;
    (book['品番'] as Array<Record<string, unknown>>)[0] = { ...(book['品番']?.[0] ?? {}), 品名: '試験用 ブラケット（改）' };
    (book['作業者'] as Array<Record<string, unknown>>).push({ コード: 'TEST-W05', 氏名: '試験 五郎', 有効: '×' });
    const r = await importWorkbook(t.store, book as Workbook, opts(true));
    expect(r.counts).toMatchObject({ create: 1, update: 1, error: 0 });
    expect(r.rows.find((x) => x.action === 'update')).toMatchObject({ sheet: '品番', key: 'TEST-C01/TEST-A100', messages: ['変更: 品名'] });
    const c1 = await idOf('customers', '-', 'TEST-C01');
    const a100 = await idOf('products', c1, 'TEST-A100');
    const audit = (await auditEventsFor(t.store, 'MASTER:products', a100)).find((a) => a.action === 'MASTER_UPDATE');
    expect(audit).toMatchObject({ actorId, reason: '一括登録（試験）' });
    const w5 = await idOf('workers', '-', 'TEST-W05');
    expect((await t.store.get<Record<string, unknown>>(`${C.workers}/${w5}`))?.['active']).toBe(false);
  });

  it('エラー（ない親コード・○×以外・必須の空欄・重複・不正な区分）があれば1件も書き込まず、行番号と理由を返す', async () => {
    const book: Workbook = {
      お客様: [{ コード: 'TEST-C09', 名称: '試験 追加', 締め日: 15 }],
      品番: [
        { お客様コード: 'NOPE', 品番: 'X1', 品名: 'x', 精算区分: '数量' },
        { お客様コード: 'TEST-C09', 品番: 'X2', 品名: 'x', 精算区分: '重さ' },
        { お客様コード: 'TEST-C09', 品番: 'X3', 品名: '', 精算区分: '数量', ロット必須: 'たぶん' },
      ],
      作業者: [
        { コード: 'TEST-W09', 氏名: 'a' },
        {},
        { コード: 'TEST-W09', 氏名: 'b' },
      ],
      利用者: [{ ログインID: 'x', 表示名: 'y', 区分: '社長' }],
    };
    const r = await importWorkbook(t.store, book, opts(true));
    expect(r.applied).toBe(false);
    const errors = r.rows.filter((x) => x.action === 'error').map((x) => `${x.sheet}:${x.row}:${x.messages.join('|')}`);
    expect(errors).toEqual([
      expect.stringMatching(/^品番:2:お客様コード「NOPE」がありません/),
      expect.stringMatching(/^品番:3:「精算区分」は 数量・時間 のどれかです/),
      expect.stringMatching(/^品番:4:.*「品名」を入力してください。.*「ロット必須」は ○ または × で入力してください/),
      expect.stringMatching(/^作業者:4:同じシートに同じキーの行が2回あります/),
      expect.stringMatching(/^利用者:2:.*「区分」は 現場・事務・管理者・監査.*ログインID/),
    ]);
    // 1件も書き込んでいない（エラーの無い行も）
    expect(await idOf('customers', '-', 'TEST-C09')).toBeNull();
    expect(await idOf('workers', '-', 'TEST-W09')).toBeNull();
  });

  it('期間ルール（単価・固定費）: 品番＋作業内容＋適用開始で既存を判定。期間の重なりは MasterService の規則でエラー', async () => {
    const book: Workbook = {
      単価: [
        { お客様コード: 'TEST-C01', 品番: 'TEST-A100', 作業内容コード: '', 単価: '4.4', 適用開始: new Date(Date.UTC(2026, 11, 1)) },
        { お客様コード: 'TEST-C01', 品番: 'TEST-A100', 作業内容コード: 'INSP', 単価: 5, 割増率: '1.5', 適用開始: '2026/12/01', 適用終了: '2027/03/31' },
      ],
      固定費: [{ お客様コード: 'TEST-C01', 品番: 'TEST-A100', 名称: '保管料', 金額: 5000, 適用開始: '2026/12/01' }],
    };
    const r1 = await importWorkbook(t.store, book, opts(true));
    expect(r1.counts).toMatchObject({ create: 3, error: 0 });
    const r2 = await importWorkbook(t.store, book, opts(true));
    expect(r2.counts).toMatchObject({ create: 0, same: 3 });
    const overlap = await importWorkbook(t.store, { 単価: [{ お客様コード: 'TEST-C01', 品番: 'TEST-A100', 作業内容コード: '', 単価: '9', 適用開始: '2027/01/01' }] }, opts(true));
    expect(overlap.counts.error).toBe(1);
  });
});
