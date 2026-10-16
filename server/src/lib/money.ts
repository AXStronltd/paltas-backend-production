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

/**
 * An amount as people read it in a message: "KES 66,300.00" (minor units in, the currency's own decimals out).
 * Every server message that quotes money uses this; raw minor units never reach a person.
 */
export function formatMoney(minor: number, currency: string): string {
  const d = decimalsOf(currency);
  const n = new Intl.NumberFormat("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }).format(
    toMajor(minor, currency),
  );
  return `${currency} ${n}`;
}
