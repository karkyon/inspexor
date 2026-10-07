import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculateQuantityAmount, calculateTimeAmount } from './rate-calculation';
import golden from '../../../billing-golden.json';

describe('calculateQuantityAmount (billing-golden G-QTY-*, G-ROUND-*)', () => {
  const cases = golden.cases.filter((c) => c.id.startsWith('G-QTY-') || c.id.startsWith('G-ROUND-'));
  expect(cases.length).toBeGreaterThan(0);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const input = testCase.input as { quantity: number; unitPrice: string };
      const expected = testCase.expected as { raw?: string; amountYen: number };
      const result = calculateQuantityAmount(input);
      if (expected.raw !== undefined) {
        expect(new Decimal(result.raw).equals(new Decimal(expected.raw))).toBe(true);
      }
      expect(result.amountYen).toBe(expected.amountYen);
    });
  }
});

describe('calculateTimeAmount (billing-golden G-BILL-*)', () => {
  const cases = golden.cases.filter((c) => c.id.startsWith('G-BILL-'));
  expect(cases.length).toBeGreaterThan(0);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const input = testCase.input as {
        regularPersonMinutes: number;
        overtimePersonMinutes: number;
        unitPrice: string;
        multiplier: string;
      };
      const expected = testCase.expected as {
        regularRaw: string;
        overtimeRaw: string;
        amountYen: number;
      };
      const result = calculateTimeAmount(input);
      expect(new Decimal(result.regularRaw).equals(new Decimal(expected.regularRaw))).toBe(true);
      expect(new Decimal(result.overtimeRaw).equals(new Decimal(expected.overtimeRaw))).toBe(true);
      expect(result.amountYen).toBe(expected.amountYen);
    });
  }
});
