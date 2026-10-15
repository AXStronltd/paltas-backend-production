/*
 * Money helpers. Amounts are stored and sent as integer MINOR units (cents). The entitlement rules work in major
 * units (e.g. 25000.00 KES); these helpers convert at the edge, using each currency's own number of decimals.
 */

/** ISO 4217 currencies with no minor unit (0 decimals). Every other currency is treated as 2 decimals. */
const ZERO_DECIMAL = new Set([
  "UGX",
  "RWF",
  "BIF",
  "JPY",
  "KRW",
  "VND",
  "XAF",
  "XOF",
  "CLP",
  "PYG",
  "GNF",
  "KMF",
  "DJF",
]);

export function decimalsOf(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** decimalsOf(currency));
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** decimalsOf(currency);
}
