import Decimal from 'decimal.js';

export type Yen = number;
export type DecimalInput = string | number | Decimal;

export function toDecimal(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/**
 * 00契約 不変条件8: 明細額と税はROUND_HALF_UPで整数円。
 */
export function roundHalfUpToYen(value: DecimalInput): Yen {
  return toDecimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}
