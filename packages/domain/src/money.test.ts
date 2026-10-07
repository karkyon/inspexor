import { describe, it, expect } from 'vitest';
import { roundHalfUpToYen } from './money';

describe('roundHalfUpToYen', () => {
  it('rounds .5 away from zero', () => {
    expect(roundHalfUpToYen('0.5')).toBe(1);
    expect(roundHalfUpToYen('7354.6')).toBe(7355);
  });

  it('keeps already-integer values', () => {
    expect(roundHalfUpToYen(6930)).toBe(6930);
  });
});
