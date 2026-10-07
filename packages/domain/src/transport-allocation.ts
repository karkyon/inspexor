/**
 * INSPEXOR_請求・運搬費計算完全仕様書_v5.1.md 「運搬額」節。
 * 00契約 不変条件7: 1運搬報告=1便=2,500円。対象distinct品番で均等按分し、
 * 余りは端数降順、同率は品番昇順 / q=floor(2500/n), r=2500-q*n、品番コード昇順の先頭r件へ+1。
 */

export interface TransportAllocationInput {
  feeYen: number;
  /** allocation_eligible=trueのdelivery item品番コード一覧（重複可、同一品番複数itemは1対象） */
  productCodes: string[];
}

export interface TransportAllocationResult {
  amounts: Record<string, number>;
  sum: number;
  distinctCount: number;
}

function compareCodeAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function allocateTransportFee(input: TransportAllocationInput): TransportAllocationResult {
  const distinct = Array.from(new Set(input.productCodes)).sort(compareCodeAscending);
  const n = distinct.length;

  if (n === 0) {
    // NO_ALLOCATION_TARGET warning は application層の責務
    return { amounts: {}, sum: 0, distinctCount: 0 };
  }

  const q = Math.floor(input.feeYen / n);
  const r = input.feeYen - q * n;

  const amounts: Record<string, number> = {};
  distinct.forEach((code, index) => {
    amounts[code] = q + (index < r ? 1 : 0);
  });

  const sum = Object.values(amounts).reduce((total, value) => total + value, 0);

  return { amounts, sum, distinctCount: n };
}
