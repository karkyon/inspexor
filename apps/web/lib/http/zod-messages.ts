/**
 * Zod の issue を利用者向け日本語メッセージへ変換する（画面外部仕様: エラーは項目単位で日本語表示）。
 * zod 3 / 4 どちらの issue 形でも動くよう、code と付随情報を緩く読む。code はそのまま API の fields[].code に残す。
 */
export interface ZodIssueLike {
  readonly code: unknown;
  readonly message: string;
  readonly [key: string]: unknown;
}

function num(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'bigint' ? String(value) : null;
}

export function zodIssueMessageJa(issue: ZodIssueLike): string {
  const kind = String(issue['type'] ?? issue['origin'] ?? '');
  switch (issue.code) {
    case 'invalid_type':
      if (issue['received'] === 'undefined' || issue['received'] === 'null' || /received undefined/.test(issue.message)) return '必須項目です。';
      return '値の型が正しくありません。';
    case 'too_small': {
      const min = num(issue['minimum']);
      if (kind === 'string') return min === '1' ? '入力してください。' : `${min ?? ''}文字以上で入力してください。`;
      if (kind === 'array') return `${min ?? ''}件以上選択してください。`;
      return `${min ?? ''}以上で入力してください。`;
    }
    case 'too_big': {
      const max = num(issue['maximum']);
      if (kind === 'string') return `${max ?? ''}文字以内で入力してください。`;
      if (kind === 'array') return `${max ?? ''}件以内で選択してください。`;
      return `${max ?? ''}以下で入力してください。`;
    }
    case 'invalid_string':
    case 'invalid_format':
      return issue['validation'] === 'email' || issue['format'] === 'email' ? 'メールアドレスの形式が正しくありません。' : '形式が正しくありません。';
    case 'invalid_enum_value':
    case 'invalid_value':
    case 'invalid_literal':
      return '選択肢から選んでください。';
    case 'unrecognized_keys':
      return '指定できない項目が含まれています。';
    case 'not_multiple_of':
      return '桁数または刻みが正しくありません。';
    case 'invalid_date':
      return '日付が正しくありません。';
    case 'custom':
      return /[^\x00-\x7F]/.test(issue.message) ? issue.message : '入力値が正しくありません。';
    default:
      return /[^\x00-\x7F]/.test(issue.message) ? issue.message : '入力値が正しくありません。';
  }
}
