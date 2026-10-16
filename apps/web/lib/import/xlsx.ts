/**
 * CHG-013 マスタ一括登録の Excel（.xlsx）の読み書き（exceljs。運用スクリプト専用で、Web アプリからは使わない）。
 *  - 記入用テンプレート: 「記入方法」シート＋各マスタのシート（1行目が見出し、2行目から記入）。○/× や区分は選択肢付き
 *  - 試験用データ一式（sample）: TEST- で始まる試験用のお客様・品番・作業者・利用者など（T3a 試作版の確認・T5 現場テスト用）
 */
import ExcelJS from 'exceljs';
import { SHEETS, type Cell, type Workbook } from './master-import';

/** 試験用データ一式（コードはすべて TEST- で始める。本番の T5 現場テストでも実データと区別でき、後片付けの対象にできる） */
export const SAMPLE_DATA: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, Cell>>>>> = {
  お客様: [
    { コード: 'TEST-C01', 名称: '試験用 A工業株式会社', 締め日: '末', 有効: '○' },
    { コード: 'TEST-C02', 名称: '試験用 B製作所', 締め日: 20, 有効: '○' },
  ],
  品番: [
    { お客様コード: 'TEST-C01', 品番: 'TEST-A100', 品名: '試験用 ブラケット', 精算区分: '数量', ロット必須: '×', 有効: '○' },
    { お客様コード: 'TEST-C01', 品番: 'TEST-A200', 品名: '試験用 カバー（ロット管理）', 精算区分: '数量', ロット必須: '○', 有効: '○' },
    { お客様コード: 'TEST-C01', 品番: 'TEST-A300', 品名: '試験用 シャフト（時間精算）', 精算区分: '時間', ロット必須: '×', 有効: '○' },
    { お客様コード: 'TEST-C02', 品番: 'TEST-B100', 品名: '試験用 ハウジング', 精算区分: '数量', ロット必須: '×', 有効: '○' },
    { お客様コード: 'TEST-C02', 品番: 'TEST-B200', 品名: '試験用 フランジ', 精算区分: '数量', ロット必須: '×', 有効: '○' },
  ],
  作業内容: [
    ...['TEST-A100', 'TEST-A200', 'TEST-A300'].flatMap((p) => [
      { お客様コード: 'TEST-C01', 品番: p, コード: 'INSP', 名称: '外観検査', 有効: '○' },
      { お客様コード: 'TEST-C01', 品番: p, コード: 'DEBR', 名称: 'バリ取り', 有効: '○' },
    ]),
    ...['TEST-B100', 'TEST-B200'].map((p) => ({ お客様コード: 'TEST-C02', 品番: p, コード: 'INSP', 名称: '全数検査', 有効: '○' })),
  ],
  不良種別: [
    ...[
      ['TEST-C01', 'TEST-A100'],
      ['TEST-C01', 'TEST-A200'],
      ['TEST-C01', 'TEST-A300'],
      ['TEST-C02', 'TEST-B100'],
      ['TEST-C02', 'TEST-B200'],
    ].flatMap(([c, p]) => [
      { お客様コード: c, 品番: p, コード: 'D01', 名称: 'バリ', 表示順: 1, 有効: '○' },
      { お客様コード: c, 品番: p, コード: 'D02', 名称: 'キズ', 表示順: 2, 有効: '○' },
      { お客様コード: c, 品番: p, コード: 'D03', 名称: '打痕', 表示順: 3, 有効: '○' },
    ]),
  ],
  作業者: [
    { コード: 'TEST-W01', 氏名: '試験 一郎', 有効: '○' },
    { コード: 'TEST-W02', 氏名: '試験 二郎', 有効: '○' },
    { コード: 'TEST-W03', 氏名: '試験 三子', 有効: '○' },
    { コード: 'TEST-W04', 氏名: '試験 四郎', 有効: '○' },
    { コード: 'TEST-D01', 氏名: '試験 運転手', 有効: '○' },
  ],
  車両: [
    { コード: 'TEST-V01', 名称: '試験用 2tトラック', 有効: '○' },
    { コード: 'TEST-V02', 名称: '試験用 軽バン', 有効: '○' },
  ],
  作業場所: [
    { コード: 'TEST-L01', 名称: '試験用 自社工場', 有効: '○' },
    { コード: 'TEST-L02', 名称: '試験用 客先常駐', 有効: '○' },
  ],
  お客様担当者: [
    { お客様コード: 'TEST-C01', コード: 'K01', 氏名: '試験 担当者A', メール: 'test-contact-a@example.com', 日報メール: '×', 請求書メール: '×', 日報の担当品番: '', 請求書の担当品番: '', 有効: '○' },
    { お客様コード: 'TEST-C02', コード: 'K01', 氏名: '試験 担当者B', メール: 'test-contact-b@example.com', 日報メール: '×', 請求書メール: '×', 日報の担当品番: 'TEST-B100', 請求書の担当品番: '', 有効: '○' },
  ],
  休日: [],
  単価: [],
  運搬ルール: [],
  固定費: [],
  利用者: [
    { ログインID: 'test.field01', 表示名: '試験 現場1', 区分: '現場' },
    { ログインID: 'test.field02', 表示名: '試験 現場2', 区分: '現場' },
    { ログインID: 'test.office01', 表示名: '試験 事務1', 区分: '事務所' },
  ],
};

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
  }
  return String(v);
}

/** .xlsx → シート名ごとの行（1行目の見出しをキー）。知らないシートは読まない */
export async function readWorkbook(bytes: Buffer | ArrayBuffer): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as ArrayBuffer);
  const out: Record<string, Array<Record<string, Cell>>> = {};
  for (const spec of SHEETS) {
    const ws = wb.getWorksheet(spec.sheet);
    if (ws === undefined) continue;
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = String(cellValue(cell.value) ?? '').replace(/[（(]必須[)）]$/, '').trim();
    });
    const rows: Array<Record<string, Cell>> = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const rec: Record<string, Cell> = {};
      headers.forEach((h, col) => {
        if (h !== undefined && h !== '') rec[h] = cellValue(row.getCell(col).value);
      });
      rows.push(rec);
    }
    // 末尾の空行は除く（行番号を保つため途中の空行は残す）
    while (rows.length > 0 && Object.values(rows[rows.length - 1] as Record<string, Cell>).every((v) => v === null || String(v).trim() === '')) rows.pop();
    out[spec.sheet] = rows;
  }
  return out;
}

/** 記入用テンプレート（sample=true なら試験用データ一式を記入済み） */
export async function writeTemplate(sample: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'INSPEXOR';
  const guide = wb.addWorksheet('記入方法');
  guide.columns = [{ width: 18 }, { width: 22 }, { width: 60 }];
  guide.addRow(['INSPEXOR マスタ・利用者の一括登録']).font = { bold: true, size: 14 };
  guide.addRow(['1行目の見出しは変えないでください。2行目から1行に1件を記入します。空の行は読み飛ばします。']);
  guide.addRow(['既にあるコードの行は、内容が違えば更新・同じなら変更なしになります。削除はしません（使わなくなったものは「有効」を × にします）。']);
  guide.addRow(['登録の順番はシートの並び順です（お客様 → 品番 → 作業内容 → …）。親（お客様・品番）はコードで指定します。']);
  guide.addRow(['利用者は追加だけです。初期パスワードは取込時に別ファイルへ出力されます（画面・メールには出しません）。']);
  guide.addRow([]);
  guide.addRow(['シート', '列', '書き方']).font = { bold: true };
  for (const spec of SHEETS) {
    guide.addRow([spec.sheet, '', spec.note]).font = { bold: true };
    for (const c of spec.columns) guide.addRow(['', `${c.header}${c.required ? '（必須）' : ''}`, c.note]);
  }

  for (const spec of SHEETS) {
    const ws = wb.addWorksheet(spec.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = spec.columns.map((c) => ({ header: `${c.header}${c.required ? '（必須）' : ''}`, width: Math.max(12, c.header.length * 2 + 6) }));
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3ECF3' } };
    const rows = sample ? (SAMPLE_DATA[spec.sheet] ?? []) : [];
    for (const r of rows) ws.addRow(spec.columns.map((c) => r[c.header] ?? null));
    // 選択肢（200行分）
    spec.columns.forEach((c, i) => {
      const list = c.kind === 'bool' ? ['○', '×'] : c.kind === 'enum' ? Object.keys(c.values ?? {}).filter((k) => !/^[A-Z_]+$/.test(k)) : null;
      if (list === null) return;
      for (let r = 2; r <= 201; r += 1) {
        ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] };
      }
    });
    spec.columns.forEach((c, i) => {
      if (c.kind === 'date') ws.getColumn(i + 1).numFmt = 'yyyy/mm/dd';
      if (c.kind === 'text' || c.kind === 'codes') ws.getColumn(i + 1).numFmt = '@';
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
