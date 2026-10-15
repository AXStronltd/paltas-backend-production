/*
 * Bank statements: read a CSV export into lines, and suggest what each incoming line pays. Suggestions only — a
 * person in finance (not the importer) confirms each match, and the payment then goes through the core rules.
 */
import { fail } from "../../../http/errors.js";
import { parseCsv, UnreadableFile } from "../../migration/files/tables.js";
import { exactMinor } from "../adapters/translate.js";

export interface StatementLine {
  lineNo: number;
  valueDate: string;
  /** Positive = money in, negative = money out. */
  amountMinor: number;
  currency: string;
  bankRef: string;
  description: string;
}

const COLUMNS = {
  date: ["date", "value date", "transaction date", "posting date", "booking date"],
  amount: ["amount", "credit", "credit amount", "amount in"],
  reference: ["reference", "bank reference", "ref", "transaction id", "transaction reference"],
  description: ["description", "narrative", "details", "particulars", "memo"],
  currency: ["currency", "ccy"],
} as const;

const normal = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");

function toIsoDate(raw: string, format: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY"): string | null {
  const v = raw.trim();
  let y: string | undefined, m: string | undefined, d: string | undefined;
  if (format === "YYYY-MM-DD") [, y, m, d] = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) ?? [];
  else if (format === "DD/MM/YYYY") [, d, m, y] = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v) ?? [];
  else [, m, d, y] = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v) ?? [];
  if (!y || !m || !d) return null;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Read a statement CSV. Every problem is reported with its line number; nothing is guessed. */
export function parseStatement(
  csv: string,
  o: { currency: string; dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" },
): StatementLine[] {
  let grid: string[][];
  try {
    grid = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  } catch (e) {
    throw fail.invalid(e instanceof UnreadableFile ? e.message : "The statement is not a readable CSV file");
  }
  const [header, ...rows] = grid;
  if (!header || !rows.length) throw fail.invalid("The statement needs a header row and at least one line");
  const names = header.map(normal);
  const col = (k: keyof typeof COLUMNS) => names.findIndex((n) => (COLUMNS[k] as readonly string[]).includes(n));
  const at = { date: col("date"), amount: col("amount"), reference: col("reference"), description: col("description") };
  const missing = Object.entries(at)
    .filter(([k, i]) => i < 0 && k !== "description")
    .map(([k]) => k);
  if (missing.length) throw fail.invalid(`The statement has no ${missing.join(", ")} column`, { missing });
  const ccyAt = col("currency");
  const problems: string[] = [];
  const lines: StatementLine[] = [];
  rows.forEach((r, i) => {
    const lineNo = i + 2;
    const cell = (j: number) => (j >= 0 ? (r[j] ?? "").trim() : "");
    const valueDate = toIsoDate(cell(at.date), o.dateFormat);
    const rawAmount = cell(at.amount).replace(/,/g, "");
    const negative = rawAmount.startsWith("-");
    const minor = exactMinor(rawAmount.replace(/^[-+]/, ""), o.currency);
    const currency = (cell(ccyAt) || o.currency).toUpperCase();
    const bankRef = cell(at.reference);
    if (!valueDate) problems.push(`line ${lineNo}: date "${cell(at.date)}" is not ${o.dateFormat}`);
    if (minor === null) problems.push(`line ${lineNo}: amount "${cell(at.amount)}" is not an exact amount`);
    if (!/^[A-Z]{3}$/.test(currency)) problems.push(`line ${lineNo}: currency "${currency}" is not a 3-letter code`);
    if (!bankRef) problems.push(`line ${lineNo}: no bank reference`);
    if (valueDate && minor !== null && bankRef)
      lines.push({
        lineNo,
        valueDate,
        amountMinor: negative ? -minor : minor,
        currency,
        bankRef: bankRef.slice(0, 120),
        description: cell(at.description).slice(0, 500),
      });
  });
  if (problems.length)
    throw fail.invalid(`The statement has ${problems.length} problem(s): ${problems.slice(0, 5).join("; ")}`, {
      problems,
    });
  return lines;
}

export interface Candidate {
  id: string;
  kind: "reference" | "invoice";
  reference: string;
  orgId: string | null;
  amountMinor: number;
  currency: string;
}

export interface Suggestion extends Candidate {
  score: number;
  why: string;
}

const quotes = (text: string, ref: string) =>
  new RegExp(`(^|[^A-Za-z0-9])${ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(text);

/** Up to five candidates for one incoming line, best first. */
export function suggest(line: StatementLine, candidates: Candidate[]): Suggestion[] {
  const text = `${line.bankRef} ${line.description}`;
  const out: Suggestion[] = [];
  for (const c of candidates) {
    if (c.currency !== line.currency) continue;
    const quoted = quotes(text, c.reference);
    const same = c.amountMinor === line.amountMinor;
    if (quoted && same) out.push({ ...c, score: 100, why: "Reference quoted and amount equal" });
    else if (quoted) out.push({ ...c, score: 60, why: "Reference quoted, amount differs (would be held for review)" });
    else if (same) out.push({ ...c, score: 40, why: "Same amount, no reference quoted" });
  }
  return out.sort((a, b) => b.score - a.score || a.reference.localeCompare(b.reference)).slice(0, 5);
}
