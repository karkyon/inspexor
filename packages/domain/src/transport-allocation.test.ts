import { describe, it, expect } from 'vitest';
import { allocateTransportFee } from './transport-allocation';
import golden from '../../../billing-golden.json';

describe('allocateTransportFee (billing-golden G-ALLOC-*)', () => {
  const cases = golden.cases.filter((c) => c.id.startsWith('G-ALLOC-'));
  expect(cases.length).toBeGreaterThan(0);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const input = testCase.input as { feeYen: number; productCodes: string[] };
      const expected = testCase.expected as Record<string, number> & {
        sum: number;
        distinctCount?: number;
      };
      const result = allocateTransportFee(input);

      expect(result.sum).toBe(expected.sum);
      if (expected.distinctCount !== undefined) {
        expect(result.distinctCount).toBe(expected.distinctCount);
      }
      for (const [code, amount] of Object.entries(expected)) {
        if (code === 'sum' || code === 'distinctCount') continue;
        expect(result.amounts[code]).toBe(amount);
      }
    });
  }
});
