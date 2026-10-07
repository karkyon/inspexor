import { toDecimal, roundHalfUpToYen, type DecimalInput, type Yen } from './money';

/**
 * INSPEXOR_請求・運搬費計算完全仕様書_v5.1.md 「作業額」節。
 * QUANTITY: raw=quantity*unit_price
 * TIME: regularRaw=regularPersonMinutes/60*unitPrice; overtimeRaw=overtimePersonMinutes/60*unitPrice*1.25
 * lineごとROUND_HALF_UP(raw,0)
 */

export interface QuantityRateInput {
  quantity: number;
  unitPrice: DecimalInput;
}

export interface QuantityRateResult {
  raw: string;
  amountYen: Yen;
}

export function calculateQuantityAmount(input: QuantityRateInput): QuantityRateResult {
  const raw = toDecimal(input.quantity).times(toDecimal(input.unitPrice));
  return { raw: raw.toString(), amountYen: roundHalfUpToYen(raw) };
}

export interface TimeRateInput {
  regularPersonMinutes: number;
  overtimePersonMinutes: number;
  unitPrice: DecimalInput;
  multiplier: DecimalInput;
}

export interface TimeRateResult {
  regularRaw: string;
  overtimeRaw: string;
  amountYen: Yen;
}

export function calculateTimeAmount(input: TimeRateInput): TimeRateResult {
  const unitPrice = toDecimal(input.unitPrice);
  const multiplier = toDecimal(input.multiplier);
  const regularRaw = toDecimal(input.regularPersonMinutes).dividedBy(60).times(unitPrice);
  const overtimeRaw = toDecimal(input.overtimePersonMinutes).dividedBy(60).times(unitPrice).times(multiplier);
  return {
    regularRaw: regularRaw.toString(),
    overtimeRaw: overtimeRaw.toString(),
    amountYen: roundHalfUpToYen(regularRaw.plus(overtimeRaw)),
  };
}
