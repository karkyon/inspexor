import { toDecimal, roundHalfUpToYen, type DecimalInput, type Yen } from './money';

/**
 * INSPEXOR_請求・運搬費計算完全仕様書_v5.1.md 「請求期間・税」節。
 * tax=ROUND_HALF_UP(subtotal*0.10,0), total=subtotal+tax
 */

export interface TaxInput {
  subtotalYen: number;
  taxRate: DecimalInput;
}

export interface TaxResult {
  taxYen: Yen;
  totalYen: Yen;
}

export function calculateTax(input: TaxInput): TaxResult {
  const taxYen = roundHalfUpToYen(toDecimal(input.subtotalYen).times(toDecimal(input.taxRate)));
  return { taxYen, totalYen: input.subtotalYen + taxYen };
}
