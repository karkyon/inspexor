import { describe, it, expect } from 'vitest';
import { computeBusinessTime } from './business-time';
import golden from '../../../billing-golden.json';

describe('computeBusinessTime (billing-golden G-TIME-*)', () => {
  const cases = golden.cases.filter((c) => c.id.startsWith('G-TIME-'));
  expect(cases.length).toBeGreaterThan(0);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const input = testCase.input as {
        date: string;
        start: string;
        end: string;
        workers: number;
      };
      const expected = testCase.expected as {
        breakMinutes: number;
        regularMinutes: number;
        overtimeMinutes: number;
        regularPersonMinutes: number;
        overtimePersonMinutes: number;
      };
      const result = computeBusinessTime(input);
      expect(result).toEqual(expected);
    });
  }
});
