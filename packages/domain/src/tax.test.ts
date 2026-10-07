import { describe, it, expect } from 'vitest';
import { calculateTax } from './tax';
import golden from '../../../billing-golden.json';

describe('calculateTax (billing-golden G-TAX-*)', () => {
  const cases = golden.cases.filter((c) => c.id.startsWith('G-TAX-'));
  expect(cases.length).toBeGreaterThan(0);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const input = testCase.input as { subtotalYen: number; taxRate: string };
      const expected = testCase.expected as { taxYen: number; totalYen: number };
      const result = calculateTax(input);
      expect(result).toEqual(expected);
    });
  }
});
