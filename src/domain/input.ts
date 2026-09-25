/* ====================================================================== *
 * TURNING A REQUEST BODY INTO SOMETHING SAFE TO WRITE.
 *
 * Pure: no Express, no Prisma, no database. That is deliberate and it is
 * the same split the rest of this service uses — domain/ decides, http/
 * plumbs. It matters here more than usual, because this is the code that
 * decides whether an amount of money is a number, and code that decides
 * that should be testable without a database in the room.
 *
 * THE RULE THIS FILE ENFORCES: a request can write the fields its resource
 * declares, and nothing else. Not `orgId`, not `total`, not `ref`. They are
 * not in the declaration, so there is no branch here that reaches them.
 * ====================================================================== */

import pkg from "@prisma/client";
import { badRequest } from "../http/errors.ts";
import { ENUM_WORDS } from "./console-map.ts";

/*
 * THE VALUES EACH ENUM ACTUALLY ALLOWS.
 *
 * Prisma exports every enum it generated, so the list is the schema's own
 * rather than a second copy kept by hand — which would drift the first time
 * somebody added a status.
 */
function enumValues(name: string): string[] | null {
  /*
   * Prisma's generated package is indexed by a name that is only known at
   * runtime — it comes out of a registry declaration's `enum:Whatever`. A
   * Record view of the module is the narrowest honest way to say that; the
   * alternative is `any`, and this is precisely the kind of place where one
   * `any` quietly becomes the shape of everything downstream.
   */
  const mod = pkg as unknown as Record<string, unknown>;
  const nested = mod["Prisma"] as Record<string, unknown> | undefined;
  const e = mod[name] ?? nested?.[name];
  return e !== null && typeof e === "object" ? Object.keys(e) : null;
}

/* ====================================================================== *
 * DATES THE WAY A PERSON WRITES THEM.
 *
 * The console's forms collect dates as free text — `contract/backend.md` §2
 * types them `text`, and its own screens carry "Mar 2024", "9 Sep", "Oct",
 * "Thu 10:00". A date input would send ISO; a person typing does not.
 *
 * THE TRAP THIS AVOIDS, WHICH IS WORSE THAN A REJECTION:
 *
 *     new Date("9 Sep")  →  2001-09-09
 *
 * JavaScript parses it, silently, into a year twenty-five years in the
 * past. A booking made for next week would be filed in 2001, no error
 * anywhere, and it would be found by somebody looking for a missing
 * reservation. So the formats the console actually uses are handled here
 * explicitly, and anything that is neither ISO nor one of them is refused
 * rather than guessed at.
 * ====================================================================== */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
                "jul", "aug", "sep", "oct", "nov", "dec"];

/** Placeholders the console prints for "there is no date". */
const NO_DATE = new Set(["", "-", "—", "–", "n/a", "na", "none", "tbc", "tbd"]);

export function looseDate(raw: unknown): Date | null | undefined {
  const v = String(raw).trim();
  if (NO_DATE.has(v.toLowerCase())) return null;

  /* ISO first, and anything else the engine parses UNAMBIGUOUSLY — which
     means it carried a year. "9 Sep" parses and has no year, so it must not
     take this path. */
  if (/\d{4}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const now = new Date();
  let m;

  /*
   * `?? ""` ON EVERY CAPTURED GROUP BELOW.
   *
   * A group in a pattern with no `?` always matched if the pattern did, so
   * these are never actually undefined. TypeScript cannot know that — a
   * regex's shape is not in its type — and the alternative is a `!` on each,
   * which asserts rather than handles. An empty string reaches the same
   * `indexOf` and `Number()` that a missing one would, and both already have
   * a defined answer for it.
   */

  /* "02:00" or "14:20" — a time today. */
  if ((m = v.match(/^(\d{1,2}):(\d{2})$/))) {
    return at(now.getFullYear(), now.getMonth(), now.getDate(),
      Number(m[1] ?? ""), Number(m[2] ?? ""));
  }

  /* "Thu 10:00" — the next such weekday, at that time. */
  if ((m = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2}):(\d{2})$/))) {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const want = days.indexOf((m[1] ?? "").slice(0, 3).toLowerCase());
    if (want >= 0) {
      const ahead = (want - now.getDay() + 7) % 7;
      const d = at(now.getFullYear(), now.getMonth(), now.getDate() + ahead,
        Number(m[2] ?? ""), Number(m[3] ?? ""));
      return d;
    }
  }

  /* "9 Sep" or "Sep 9" — this year. THE ONE THAT MATTERS. */
  /*
   * "9 Sep" and "Sep 9" are the same date written two ways, so the second
   * match is reordered into the first's shape. Written as a plain array
   * rather than reassigning the match, because a RegExpMatchArray carries
   * `index` and `input` that nothing here reads and the compiler is right to
   * notice a mismatch.
   */
  const dayFirst = v.match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/);
  const monthFirst = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  const parts: [string, string] | null =
    dayFirst ? [dayFirst[1] ?? "", dayFirst[2] ?? ""]
    : monthFirst ? [monthFirst[2] ?? "", monthFirst[1] ?? ""]
    : null;
  if (parts) {
      const mon = MONTHS.indexOf(parts[1].slice(0, 3).toLowerCase());
    const day = Number(parts[0]);
    if (mon >= 0 && day >= 1 && day <= 31) {
      return at(now.getFullYear(), mon, day, 0, 0);
    }
  }

  /* "Oct" — the first of that month, this year. */
  if ((m = v.match(/^([A-Za-z]{3,9})$/))) {
    const mon = MONTHS.indexOf((m[1] ?? "").slice(0, 3).toLowerCase());
    if (mon >= 0) return at(now.getFullYear(), mon, 1, 0, 0);
  }

  return undefined;                       // not a date, and not "no date"
}

const at = (y: number, mo: number, d: number, h: number, mi: number): Date =>
  new Date(Date.UTC(y, mo, d, h, mi));

/**
 * WHAT clean() NEEDS FROM A RESOURCE DECLARATION.
 *
 * Only the three things it reads. The full declaration type arrives with the
 * registry in Phase 3; naming a smaller shape here means this module does not
 * have to wait for it, and says plainly that validation does not care about
 * the other twelve keys.
 *
 * `fields` maps a column to its kind — "string", "money", "id:project",
 * "enum:DefectStatus". Those strings become a checked union in Phase 3, and
 * this signature is what will carry it.
 */
export interface CleanableResource {
  readonly fields: Readonly<Record<string, string>>;
  readonly required?: readonly string[];
  readonly model?: string;
  /** The console's own abbreviations for these columns. See console-map.js. */
  readonly aliases?: Readonly<Record<string, string>>;
}

/**
 * The values safe to write.
 *
 * `clean()` THROWS rather than returning problems — a badRequest carrying
 * every refusal, with the first as the sentence. I typed it as a result pair
 * first, which is the shape it looks like it should have, and the compiler
 * pointed at the `return out` that proved otherwise. Describing what code does
 * rather than what it ought to do is most of the value of doing this at all.
 */
export type CleanedData = Record<string, unknown>;

const MAX_TEXT = 4000;
const MAX_STRING = 300;

/**
 * Turn a request body into something safe to write.
 *
 * ONLY DECLARED FIELDS SURVIVE. Everything else is dropped silently —
 * not rejected, because a frontend that sends back the row it was given
 * would then be unable to save anything, and every read-modify-write would
 * fail for a reason nobody could see. What matters is that `orgId`,
 * `total`, `ref` and the rest cannot be written, and they cannot: they are
 * not in the declaration, so they never reach the query.
 */
export function clean(
  resource: CleanableResource,
  body: unknown,
  { partial }: { readonly partial?: boolean },
): CleanedData {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  const source: Record<string, unknown> =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  /*
   * THE CONSOLE'S NAMES, ACCEPTED ALONGSIDE THIS SERVICE'S.
   *
   * `{n, cat, host, veh}` becomes `{visitor, category, hostName, vehicle}`
   * before anything else looks at it, so every rule below — required,
   * lengths, money, dates — is written once against one set of names.
   *
   * The service's own name WINS if both are present. A caller sending both
   * has a bug, and the longer name is the one an API client means.
   */
  const named: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(resource.aliases ?? {})) {
    if (from in source && !(to in source)) named[to] = source[from];
  }
  const given: Record<string, unknown> = { ...named, ...source };

  for (const [key, kind] of Object.entries(resource.fields)) {
    if (!(key in given)) continue;
    const v = given[key];

    /* An explicit null clears an optional field. Undefined does not — the
       difference between "set this to nothing" and "I am not sending it". */
    if (v === null) { out[key] = null; continue; }
    if (v === undefined) continue;

    if (kind === "string" || kind === "text" || kind.startsWith("id:")) {
      const s = String(v).trim();
      const cap = kind === "text" ? MAX_TEXT : MAX_STRING;
      if (s.length > cap) { problems.push(`${key} is longer than ${cap} characters.`); continue; }
      out[key] = s === "" && kind.startsWith("id:") ? null : s;

    } else if (kind === "int" || kind === "money" || kind === "signed-money") {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push(`${key} must be a number.`); continue; }
      /*
       * MONEY IS AN INTEGER IN MINOR UNITS, AND IT IS NEVER NEGATIVE HERE.
       *
       * A negative rent, a negative invoice line or a negative deposit is
       * always a bug or an attempt, and the one legitimate negative — a
       * refund — is a payment, which has its own endpoint and its own sign.
       *
       * ── EXCEPT WHERE THE SIGN IS THE POINT ─────────────────────────────
       *
       * `signed-money` is the deliberate opposite, and it exists for exactly
       * one shape of thing: an amount that can legitimately go both ways
       * because it is a CHANGE to a figure rather than the figure itself. A
       * variation that omits a balcony reduces a contract, and forcing it
       * positive would mean recording a credit as a charge — which is worse
       * than the bug the rule above prevents.
       *
       * It is a separate kind rather than a flag so that every use of it is
       * visible in the registry: `money` is the default and stays strict, and
       * anything wanting the other behaviour has to say so by name.
       */
      if (!Number.isSafeInteger(Math.round(n))) { problems.push(`${key} is too large.`); continue; }
      const i = Math.round(n);
      if (i < 0 && kind === "money") { problems.push(`${key} cannot be negative.`); continue; }
      out[key] = i;

    } else if (kind === "float") {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push(`${key} must be a number.`); continue; }
      out[key] = n;

    } else if (kind === "bool") {
      out[key] = Boolean(v);

    } else if (kind === "date") {
      const d = looseDate(v);
      if (d === undefined) {
        problems.push(
          `${key} is not a date. Try a full date, or the way the console writes ` +
          `one — "9 Sep", "Mar 2024", "Thu 10:00".`);
        continue;
      }
      out[key] = d;

    } else if (kind.startsWith("enum:")) {
      /*
       * The console writes these the way a person reads them — "Needs
       * work", "Short stay", "One visit" — and upper-casing with spaces
       * replaced covers nearly all of them. ENUM_WORDS holds the ones it
       * does not reach: "1 bed" would become "1_BED", which is not an
       * identifier and not what the enum is called.
       */
      const spelled = String(v).trim().toUpperCase();
      const words: Readonly<Record<string, string>> = ENUM_WORDS;
      const named = words[spelled] ??
                    words[spelled.replace(/[\s-]+/g, "_")] ??
                    spelled.replace(/[\s-]+/g, "_");

      /*
       * AND IT HAS TO BE ONE THE ENUM ACTUALLY HAS.
       *
       * This normalised the spelling and then passed ANYTHING through.
       * A value the enum does not hold reached Prisma, which threw, and the
       * caller was told "Something went wrong at our end" — a 500, for a
       * value they had typed. POST /payouts with status "PAID" did exactly
       * that: the enum has SENT, not PAID.
       *
       * It is their input, so it is a 400, and it names what is allowed
       * rather than making somebody guess. An enum this cannot resolve is
       * left alone rather than refused — a missing generated client should
       * not start rejecting valid values.
       */
      const allowed = enumValues(kind.slice(5));
      if (allowed && !allowed.includes(named)) {
        problems.push(
          `${key} cannot be "${String(v).trim()}". It has to be one of: ` +
          allowed.join(", ") + ".");
        continue;
      }
      out[key] = named;

    } else if (kind === "json") {
      out[key] = v;
    }
  }

  if (!partial) {
    for (const key of resource.required || []) {
      const v = out[key];
      if (v === undefined || v === null || v === "") problems.push(`${key} is required.`);
    }
  }

  if (problems.length) throw badRequest(String(problems[0]), problems);
  return out;
}


/* ====================================================================== *
 * READING WHAT clean() PRODUCED.
 *
 * `clean()` has already checked each field against the KIND its resource
 * declared — a "string" really is a string and a "date" really is a Date by
 * the time it returns. What the return type cannot say is WHICH field is
 * which, because the declaration is a runtime map and the keys are not known
 * until it runs.
 *
 * So these are the three readers, named the same way the registry's column
 * readers are (statusOf, textOf, dateOf in domain/registry-types.ts). A
 * caller says which kind it declared, and gets that kind back.
 *
 * They are NOT casts. Each one checks, and each one has a defined answer for
 * a field that is absent — which is the normal case on a partial update.
 * ====================================================================== */

/** A declared "string" or "text" field. Absent reads as "". */
export const cleanText = (data: CleanedData, key: string): string => {
  const v = data[key];
  return typeof v === "string" ? v : "";
};

/** A declared "date" field. Absent, or cleared, reads as null. */
export const cleanDate = (data: CleanedData, key: string): Date | null => {
  const v = data[key];
  return v instanceof Date ? v : null;
};

/** Whether the body mentioned this field at all — which a PATCH turns on. */
export const cleanHas = (data: CleanedData, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(data, key);
