/*
 * Source text → PALTAS values. Two steps, both visible to the person migrating:
 *   1. the column's own transforms (trim, date format, number separators, enum map, default, extract);
 *   2. conversion to the field's type (date, money in integer minor units, email, phone, enum …).
 * Conversion never guesses silently: a value that cannot be read exactly is an error the person resolves.
 */
import type { ParseSettings, Transform } from "@paltas/contracts";
import { decimalsOf } from "../../lib/money.js";
import type { FieldSpec } from "./domain.js";
import { serialToDate } from "./files/tables.js";

export type Converted = { ok: true; value: unknown } | { ok: false; message: string };

const DATE_PATTERNS: Record<ParseSettings["dateFormat"], RegExp> = {
  "YYYY-MM-DD": /^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})$/,
  "DD/MM/YYYY": /^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})$/,
  "MM/DD/YYYY": /^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})$/,
  "DD.MM.YYYY": /^(?<d>\d{1,2})\.(?<m>\d{1,2})\.(?<y>\d{4})$/,
  "DD-MM-YYYY": /^(?<d>\d{1,2})-(?<m>\d{1,2})-(?<y>\d{4})$/,
};

/** Read a date in the given format (ISO dates and spreadsheet day numbers are always understood). */
export function parseDate(s: string, format: ParseSettings["dateFormat"]): string | null {
  const v = s.trim();
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 20_000 && n < 80_000) return serialToDate(n);
  }
  const m = DATE_PATTERNS[format].exec(v) ?? DATE_PATTERNS["YYYY-MM-DD"].exec(v.slice(0, 10));
  if (!m?.groups) return null;
  const iso = `${m.groups.y}-${m.groups.m?.padStart(2, "0")}-${m.groups.d?.padStart(2, "0")}`;
  const t = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A number written with the given separators → { negative, whole digits, fraction digits }, exactly (no floats).
 * Accepts "(1,200.50)" and "-1200,5" style negatives and a leading or trailing currency code or symbol.
 */
export function parseDecimal(
  s: string,
  decimalSeparator: string,
  thousandsSeparator: string,
): { negative: boolean; whole: string; fraction: string; currency: string | null } | null {
  let v = s.trim();
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1).trim();
  }
  const cur = /^([A-Z]{3}|[$€£])\s*|\s*([A-Z]{3})$/.exec(v);
  const currency = cur ? (cur[1] ?? cur[2] ?? null) : null;
  if (cur) v = v.replace(cur[0], "").trim();
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1).trim();
  }
  if (thousandsSeparator) v = v.split(thousandsSeparator).join("");
  const parts = v.split(decimalSeparator);
  if (parts.length > 2) return null;
  const [whole = "", fraction = ""] = parts;
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(fraction) || (!whole && !fraction)) return null;
  return {
    negative,
    whole: whole || "0",
    fraction,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
  };
}

function toMinorExact(
  s: string,
  currency: string,
  settings: ParseSettings,
): { ok: true; minor: number } | { ok: false; message: string } {
  const n = parseDecimal(s, settings.decimalSeparator, settings.thousandsSeparator);
  if (!n) return { ok: false, message: `"${s}" is not an amount` };
  if (n.currency && n.currency !== currency)
    return { ok: false, message: `"${s}" is in ${n.currency}; this migration is in ${currency}` };
  const d = decimalsOf(currency);
  const frac = n.fraction.replace(/0+$/, "");
  if (frac.length > d) return { ok: false, message: `"${s}" has more decimals than ${currency} allows (${d})` };
  const minor = Number(n.whole + frac.padEnd(d, "0"));
  if (!Number.isSafeInteger(minor)) return { ok: false, message: `"${s}" is too large` };
  return { ok: true, minor: n.negative ? -minor : minor };
}

/** Apply a column's transforms in order. */
export function applyTransforms(value: string, transforms: readonly Transform[]): Converted {
  let v = value;
  for (const t of transforms) {
    switch (t.op) {
      case "trim":
        v = v.trim().replace(/\s+/g, " ");
        break;
      case "upper":
        v = v.toUpperCase();
        break;
      case "lower":
        v = v.toLowerCase();
        break;
      case "default":
        if (!v.trim()) v = t.value;
        break;
      case "enum": {
        const hit = Object.entries(t.map).find(([k]) => k.trim().toLowerCase() === v.trim().toLowerCase());
        if (hit) v = hit[1];
        break;
      }
      case "extract": {
        let re: RegExp;
        try {
          re = new RegExp(t.pattern);
        } catch {
          return { ok: false, message: `The extract pattern "${t.pattern}" is not valid` };
        }
        const m = re.exec(v);
        v = m ? (m[1] ?? m[0]) : "";
        break;
      }
      case "date": {
        if (!v.trim()) break;
        const d = parseDate(v, t.format);
        if (!d) return { ok: false, message: `"${v}" is not a date in the format ${t.format}` };
        v = d;
        break;
      }
      case "number": {
        if (!v.trim()) break;
        const n = parseDecimal(v, t.decimalSeparator, t.thousandsSeparator);
        if (!n) return { ok: false, message: `"${v}" is not a number` };
        v = `${n.negative ? "-" : ""}${n.whole}${n.fraction ? "." + n.fraction : ""}`;
        break;
      }
    }
  }
  return { ok: true, value: v };
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** Text (after transforms) → the field's type. Empty text → null (the caller checks required fields). */
export function convert(
  f: FieldSpec,
  text: string,
  settings: ParseSettings,
  currency: string,
  enumMap: Record<string, string> = {},
): Converted {
  const v = text.trim();
  if (!v) return { ok: true, value: null };
  switch (f.type) {
    case "text":
    case "ref":
      return v.length > 2000 ? { ok: false, message: "Text is longer than 2,000 characters" } : { ok: true, value: v };
    case "email": {
      const e = v.toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)
        ? { ok: true, value: e }
        : { ok: false, message: `"${v}" is not an email address` };
    }
    case "phone": {
      const p = v.replace(/[\s().-]/g, "");
      return /^\+?\d{7,15}$/.test(p) ? { ok: true, value: p } : { ok: false, message: `"${v}" is not a phone number` };
    }
    case "date": {
      const d = parseDate(v, settings.dateFormat);
      return d ? { ok: true, value: d } : { ok: false, message: `"${v}" is not a date (${settings.dateFormat})` };
    }
    case "money": {
      const m = toMinorExact(v, currency, settings);
      if (!m.ok) return m;
      if (m.minor < 0 && !f.signed) return { ok: false, message: `"${v}" cannot be negative` };
      if (f.min !== undefined && m.minor < f.min) return { ok: false, message: `"${v}" must be more than zero` };
      return { ok: true, value: m.minor };
    }
    case "int":
    case "decimal": {
      const n = parseDecimal(v, settings.decimalSeparator, settings.thousandsSeparator);
      if (!n || n.currency) return { ok: false, message: `"${v}" is not a number` };
      const num = Number(`${n.negative ? "-" : ""}${n.whole}.${n.fraction || "0"}`);
      if (f.type === "int" && !Number.isInteger(num)) return { ok: false, message: `"${v}" is not a whole number` };
      if ((f.min !== undefined && num < f.min) || (f.max !== undefined && num > f.max))
        return { ok: false, message: `"${v}" is outside ${f.min ?? "…"}–${f.max ?? "…"}` };
      return { ok: true, value: num };
    }
    case "enum": {
      const mapped = Object.entries(enumMap).find(([k]) => norm(k) === norm(v))?.[1] ?? v;
      const hit = (f.values ?? []).find((x) => norm(x) === norm(mapped));
      return hit
        ? { ok: true, value: hit }
        : { ok: false, message: `"${v}" is not one of: ${(f.values ?? []).join(", ")}` };
    }
  }
}
