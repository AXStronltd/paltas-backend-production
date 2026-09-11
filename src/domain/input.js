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

import { badRequest } from "../http/errors.js";
import { ENUM_WORDS } from "./console-map.js";

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

export function looseDate(raw) {
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

  /* "02:00" or "14:20" — a time today. */
  if ((m = v.match(/^(\d{1,2}):(\d{2})$/))) {
    return at(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
  }

  /* "Thu 10:00" — the next such weekday, at that time. */
  if ((m = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2}):(\d{2})$/))) {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const want = days.indexOf(m[1].slice(0, 3).toLowerCase());
    if (want >= 0) {
      const ahead = (want - now.getDay() + 7) % 7;
      const d = at(now.getFullYear(), now.getMonth(), now.getDate() + ahead, +m[2], +m[3]);
      return d;
    }
  }

  /* "9 Sep" or "Sep 9" — this year. THE ONE THAT MATTERS. */
  if ((m = v.match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/)) ||
      (m = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/) , m && (m = [m[0], m[2], m[1]]))) {
    const mon = MONTHS.indexOf(String(m[2]).slice(0, 3).toLowerCase());
    const day = Number(m[1]);
    if (mon >= 0 && day >= 1 && day <= 31) {
      return at(now.getFullYear(), mon, day, 0, 0);
    }
  }

  /* "Oct" — the first of that month, this year. */
  if ((m = v.match(/^([A-Za-z]{3,9})$/))) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) return at(now.getFullYear(), mon, 1, 0, 0);
  }

  return undefined;                       // not a date, and not "no date"
}

const at = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi));

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
export function clean(resource, body, { partial }) {
  const out = {};
  const problems = [];
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};

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
  const named = {};
  for (const [from, to] of Object.entries(resource.aliases || {})) {
    if (from in source && !(to in source)) named[to] = source[from];
  }
  const given = { ...named, ...source };

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

    } else if (kind === "int" || kind === "money") {
      const n = Number(v);
      if (!Number.isFinite(n)) { problems.push(`${key} must be a number.`); continue; }
      /*
       * MONEY IS AN INTEGER IN MINOR UNITS, AND IT IS NEVER NEGATIVE HERE.
       *
       * A negative rent, a negative invoice line or a negative deposit is
       * always a bug or an attempt, and the one legitimate negative — a
       * refund — is a payment, which has its own endpoint and its own sign.
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
      out[key] = ENUM_WORDS[spelled] ||
                 ENUM_WORDS[spelled.replace(/[\s-]+/g, "_")] ||
                 spelled.replace(/[\s-]+/g, "_");

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

  if (problems.length) throw badRequest(problems[0], problems);
  return out;
}

