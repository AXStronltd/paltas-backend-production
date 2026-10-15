/*
 * Currency arithmetic for the day's rate, in integers only. A rate is "hotel currency per 1 unit of the foreign
 * currency", stored × 1,000,000 (rate_micro). Amounts are minor units of each currency, whose decimals follow
 * ISO 4217 (most have 2; a few have 0 or 3).
 */
const DECIMALS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export const decimalsOf = (currency: string): number => DECIMALS[currency] ?? 2;

export const toRateMicro = (rate: number): number => Math.round(rate * 1_000_000);
export const fromRateMicro = (micro: number): number => micro / 1_000_000;

/** a × b ÷ c rounded half up, exactly (BigInt). */
function mulDiv(a: bigint, b: bigint, c: bigint): number {
  const n = a * b;
  const neg = n < 0n;
  const q = ((neg ? -n : n) * 2n + c) / (2n * c);
  return Number(neg ? -q : q);
}

/** Foreign minor units → hotel minor units at the rate. */
export function toLocal(foreignMinor: number, foreignCurrency: string, rateMicro: number, localCurrency: string) {
  const scale = 10n ** BigInt(decimalsOf(localCurrency));
  const foreignScale = 10n ** BigInt(decimalsOf(foreignCurrency));
  return mulDiv(BigInt(foreignMinor) * scale, BigInt(rateMicro), foreignScale * 1_000_000n);
}

/** Hotel minor units → foreign minor units at the rate. */
export function toForeign(localMinor: number, foreignCurrency: string, rateMicro: number, localCurrency: string) {
  const scale = 10n ** BigInt(decimalsOf(localCurrency));
  const foreignScale = 10n ** BigInt(decimalsOf(foreignCurrency));
  return mulDiv(BigInt(localMinor) * foreignScale, 1_000_000n, scale * BigInt(rateMicro));
}
