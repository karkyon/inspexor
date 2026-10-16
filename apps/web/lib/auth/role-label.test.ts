import { describe, expect, it } from 'vitest';
import { ROLE_LABEL, roleText } from './role-label';

describe('K-03 区分の表示', () => {
  it('要件定義書の名称で表示し、複数は「・」でつなぐ', () => {
    expect(roleText(['FIELD'])).toBe('現場');
    expect(roleText(['FIELD', 'OFFICE'])).toBe('現場・事務所');
    expect(roleText(['ADMIN', 'AUDITOR'])).toBe('管理者・監査');
    expect(Object.keys(ROLE_LABEL).sort()).toEqual(['ADMIN', 'AUDITOR', 'FIELD', 'OFFICE']);
  });
  it('未定義の値はそのまま', () => {
    expect(roleText(['X'])).toBe('X');
    expect(roleText([])).toBe('');
  });
});
