import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodIssueMessageJa } from './zod-messages';

function first(schema: z.ZodTypeAny, value: unknown): string {
  const r = schema.safeParse(value);
  if (r.success) throw new Error('expected failure');
  return zodIssueMessageJa(r.error.issues[0] as never);
}

describe('zodIssueMessageJa', () => {
  it('未入力は必須', () => {
    expect(first(z.object({ code: z.string() }), {})).toBe('必須項目です。');
  });
  it('文字数の上下限', () => {
    expect(first(z.string().min(1), '')).toBe('入力してください。');
    expect(first(z.string().max(3), 'abcd')).toBe('3文字以内で入力してください。');
  });
  it('数値の上下限', () => {
    expect(first(z.number().int().min(1), 0)).toBe('1以上で入力してください。');
    expect(first(z.number().int().max(31), 32)).toBe('31以下で入力してください。');
  });
  it('email・enum・未知項目', () => {
    expect(first(z.string().email(), 'x')).toBe('メールアドレスの形式が正しくありません。');
    expect(first(z.enum(['A', 'B']), 'C')).toBe('選択肢から選んでください。');
    expect(first(z.object({}).strict(), { x: 1 })).toBe('指定できない項目が含まれています。');
  });
  it('日本語の custom message はそのまま、英語は汎用文言', () => {
    expect(first(z.string().refine(() => false, '日付が不正です。'), 'a')).toBe('日付が不正です。');
    expect(first(z.string().refine(() => false, 'bad'), 'a')).toBe('入力値が正しくありません。');
  });
});
