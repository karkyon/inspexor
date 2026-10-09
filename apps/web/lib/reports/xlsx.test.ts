import { describe, it, expect } from 'vitest';
import { buildXlsx, crc32, safeSheetName, zipStore } from './xlsx';

function entries(zip: Uint8Array): string[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const len = v.getUint16(p + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + len)));
    p += 46 + len;
  }
  return names;
}

describe('最小 xlsx 書き出し（CHG-004 D4）', () => {
  it('CRC-32 の検査値', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });
  it('ZIP: ローカルヘッダと中央ディレクトリが一致', () => {
    const z = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
    expect(new DataView(z.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(entries(z)).toEqual(['a.txt']);
  });
  it('ブック構成・シート名の無害化・XML エスケープ・数値セル', () => {
    const x = buildXlsx([{ name: '集計/2026[08]', header: ['品名', '数量'], rows: [['A&B<C>', 1600], [null, 0]] }]);
    expect(entries(x)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const text = new TextDecoder().decode(x);
    expect(text).toContain('<sheet name="集計202608"');
    expect(text).toContain('A&amp;B&lt;C&gt;');
    expect(text).toContain('<c r="B2"><v>1600</v></c>');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(() => buildXlsx([])).toThrow();
  });
});
