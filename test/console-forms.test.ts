/* ====================================================================== *
 * EVERY FORM IN THE BUILT PRODUCT, POSTED FOR REAL.
 *
 * This is the test that answers "does the backend match our frontend".
 * Not by reading, and not by my summary of the contract: it PARSES
 * `contract/backend.md` §2 — the table of all 27 console forms and the
 * exact fields each one posts — and sends each of them at the running API,
 * through the real Express app.
 *
 * If somebody adds a form to §2, or changes a field name in it, this test
 * fails until the server can take it. The frontend's specification is the
 * thing being executed, so the two cannot drift apart quietly.
 *
 * WHAT EACH FORM MUST DO:
 *
 *   1. Be accepted — 201, not 400 and certainly not 500.
 *   2. Land in the right resource.
 *   3. Keep every value. A field that saves and is silently dropped is the
 *      worst outcome of the three, because nothing anywhere reports it and
 *      the customer concludes the product loses data.
 *
 * Values come from the console's OWN seed arrays where possible, so the
 * enum wording, the loose dates ("Mar 2024", "9 Sep") and the money
 * formatting are the real ones the product uses rather than tidy examples.
 * ====================================================================== */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.ts";
import { CONSOLE_FORMS } from "../src/domain/console-map.ts";
import prismaPkg from "@prisma/client";
import { portOf } from "./wire.ts";
import { present } from "./wire.ts";
import type { Wire, Reply } from "./wire.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

process.env.DATABASE_URL ||= "postgresql://fake@127.0.0.1:5432/fake";
process.env.SESSION_SECRET ||= "test-secret";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = typeof mock.module === "function"
  ? false
  : "run with --experimental-test-module-mocks (npm test does)";

/*
 * LOADED INSIDE A `try`, SO THEY ARE DECLARED OUTSIDE IT.
 *
 * Importing the service pulls in the Prisma client, and a checkout where
 * nobody has run `prisma generate` throws on that import rather than failing
 * a test — a setup problem, reported as one below.
 *
 * `typeof import(...)` is the module's own type, so these handles are checked
 * against the real thing rather than carried as `any`.
 */
/*
 * THE STAND-IN, NOT THE REAL CLIENT.
 *
 * `createFakeDb()` builds an in-memory Prisma from schema.prisma — see
 * test/fake-prisma.ts. It satisfies what the routes call and not the 138
 * methods a real PrismaClient carries, which is the point: this suite runs
 * the real Express app with no database at all.
 */
let db: import("./fake-prisma.ts").FakeDb;
let createApp: typeof import("../src/server.ts")["createApp"];
if (!skip) {
  const { createFakeDb } = await import("./fake-prisma.ts");
  db = createFakeDb();
  mock.module("../src/db.ts", {
  namedExports: {
    db,
    closeDb: async () => {},
    /* `delegate` is how the resource framework reaches a model chosen at run
       time, and it lives beside the real client — so a fake client supplies it
       too. Without it the framework has no accessor and every generated
       endpoint fails at once. */
    delegate: (model: Wire) => db[model],
  },
});
  ({ createApp } = await import("../src/server.ts"));
}

/* ====================================================================== *
 * READING §2 OUT OF THE CONTRACT.
 * ====================================================================== */

/** `| \`s_visitors\` | ＋ Register visitor | \`n:text, cat:enum(...), …\` |` */
function parseForms() {
  const md = readFileSync(join(HERE, "..", "contract", "backend.md"), "utf8");
  const from = md.indexOf("## 2. Create endpoints");
  const to = md.indexOf("## 3. Endpoints named");
  assert.ok(from > 0 && to > from, "§2 is no longer in contract/backend.md");

  const forms: Record<string, { button: string; fields: Record<string, string> }> = {};
  for (const line of md.slice(from, to).split("\n")) {
    const m = line.match(/^\|\s*`(\w+)`\s*\|([^|]*)\|\s*`(.+?)`\s*\|\s*$/);
    if (!m) continue;

    const fields: Record<string, string> = {};
    /* Split on commas OUTSIDE the enum parentheses — `enum(a|b, c)` would
       otherwise be torn in half. */
    let depth = 0, cur = "";
    const parts = [];
    for (const ch of m[3]) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);

    for (const p of parts) {
      const [name, kind] = p.split(":");
      if (!name || !kind) continue;
      fields[name.trim()] = String(kind).trim();
    }
    forms[String(m[1])] = { button: String(m[2]).trim(), fields };
  }
  return forms;
}

const FORMS = parseForms();

/**
 * A value the console would really send.
 *
 * `enum(Owner|Buyer|Tenant|Guest)` → "Owner", exactly as the dropdown
 * spells it, so the wording is what gets tested rather than a tidied
 * version of it.
 */
let unique = 0;

function valueFor(consoleField: Wire, kind: Wire) {
  if (kind.startsWith("enum(")) return kind.slice(5, -1).split("|")[0].trim();
  if (kind === "num") return 4;

  /*
   * The loose dates and labels the console really uses, so that the parsing
   * under test is the parsing the product needs — "9 Sep", not an ISO date
   * nobody's form produces.
   *
   * `exp` is a real expiry here rather than the "—" the console PRINTS for
   * a document with none: a person filling the form in types a date, and
   * "—" is what the table shows afterwards when they left it blank. That it
   * correctly becomes null is asserted separately, below.
   */
  const REAL = {
    since: "Mar 2024", close: "Oct", due: "Mar 2027", exp: "31 Dec 2027",
    when: "Thu 10:00", inn: "9 Sep", valid: "Mondays, 08:00–12:00",
    shift: "06:00 – 18:00", open: "18:00–23:00", eta: "14:20",
    post: "Main gate · Riverside", route: "Riverside — perimeter",
  };
  const known = REAL as Record<string, string>;
  if (known[consoleField]) return known[consoleField];

  /*
   * Anything else is unique per call. Several of these columns carry a
   * uniqueness constraint — a number plate, a unit reference — and reusing
   * one value makes the SECOND post a 409 that looks like a bug in the form
   * rather than the constraint doing its job.
   */
  unique += 1;
  if (consoleField === "plate") return `KDJ ${100 + unique}R`;
  if (consoleField === "bay") return `B-${unique}`;
  if (consoleField === "id") return `RC-${unique}`;
  return `Console ${consoleField} ${unique}`;
}

/* ---------------------------------------------------------------- rig */

let server: import("node:http").Server;
let base: string;
let cookie: string;
/* The company everything below is created inside. Held so that a reference to
   a model NO RESOURCE OWNS can be made directly, the way the framework reads
   it — see referenceTo(). */
let ORG: import("./fake-prisma.ts").Row | null = null;

async function boot() {
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${portOf(server)}`;

  const org = ORG = await db.organization.create({
    data: {
      name: "Console Test Ltd",
      subscription: { create: { status: "ACTIVE" } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { preferred: "PROPERTY_MANAGEMENT" } },
      entitlements: {
        create: [
          { product: "PROPERTY_MANAGEMENT" }, { product: "HOTEL_MANAGEMENT" },
          { product: "AGENT_HOST" }, { product: "SECURITY_MANAGEMENT" },
        ],
      },
    },
  });
  const user = await db.user.create({
    data: { email: "console@example.com", name: "Console Person", googleSub: "sub_console" },
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  /* OWNER, so that a refusal is never about permissions — this file is
     about whether the FIELDS work. */
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role: "OWNER" } });
  cookie = `paltas_session=${token}`;

  /* Sites exist first: zones and anything else with a required reference
     needs one, and that is a real dependency rather than a test artifact. */
  const site = await post("/sites", { name: "Riverside Court", city: "Nairobi" });
  return site;
}

async function post(path: Wire, body: Wire) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Wire = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/* The site everything below is created inside — one `+ Add` form needs one
   selected, the way the console does. */
let SITE: Reply | null = null;
if (!skip) { test.before(async () => { SITE = await boot(); }); }
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

/* ================================================================ */

test("the contract still lists all 27 forms", { skip }, () => {
  assert.equal(Object.keys(FORMS).length, 27,
    `§2 of contract/backend.md now lists ${Object.keys(FORMS).length} forms, not 27. ` +
    `If the product grew a form, map it in domain/console-map.js.`);
});

test("every console form has somewhere to post to", { skip }, () => {
  const unmapped = [];
  for (const screen of Object.keys(FORMS)) {
    const form = CONSOLE_FORMS[screen];
    if (!form) { unmapped.push(`${screen} — no entry in console-map.js`); continue; }
    if (!RESOURCES[form.resource]) {
      unmapped.push(`${screen} → "${form.resource}", which is not a resource`);
    }
  }
  assert.deepEqual(unmapped, [],
    "These console screens have a create button and nowhere to send it:\n  " +
    unmapped.join("\n  "));
});

test("every field of every form maps to a column that exists", { skip }, () => {
  const problems = [];
  for (const [screen, spec] of Object.entries(FORMS)) {
    const form = CONSOLE_FORMS[screen];
    if (!form) continue;
    const resource = RESOURCES[form.resource];

    for (const consoleField of Object.keys(spec.fields)) {
      const mapped = form.fields[consoleField];
      if (!mapped) {
        problems.push(
          `${screen}.${consoleField} is in the contract and not in console-map.js — ` +
          `the console would send it and the server would drop it silently`);
        continue;
      }
      if (!resource.fields[mapped]) {
        problems.push(
          `${screen}.${consoleField} → "${mapped}", which "${form.resource}" does not ` +
          `declare as a writable field`);
      }
    }

    /* And nothing mapped that the contract does not list — a stale alias is
       a field nobody sends and everybody has to read past. */
    for (const consoleField of Object.keys(form.fields)) {
      if (!(consoleField in spec.fields)) {
        problems.push(
          `console-map.js maps ${screen}.${consoleField}, which §2 does not list. ` +
          `Either the contract changed or the alias is stale.`);
      }
    }
  }
  assert.deepEqual(problems, [], "Console ↔ API field mapping:\n  " + problems.join("\n  "));
});

test("all 27 forms post successfully, and nothing is silently dropped", { skip }, async () => {
  const failures = [];

  for (const [screen, spec] of Object.entries(FORMS)) {
    const form = CONSOLE_FORMS[screen];
    if (!form) continue;

    const body: Record<string, unknown> = {};
    for (const [consoleField, kind] of Object.entries(spec.fields)) {
      body[consoleField] = valueFor(consoleField, kind);
    }
    /* The one dependency the console satisfies by having a site selected. */
    if (form.resource === "zones") {
      body["siteId"] = present(SITE, "no site was made").json.site.id;
    }

    const res = await post(`/${form.resource}`, body);
    if (res.status !== 201) {
      failures.push(`${screen} (${spec.button}) → POST /${form.resource} answered ` +
                    `${res.status}: ${res.text.slice(0, 220)}`);
      continue;
    }

    /* THE IMPORTANT HALF. 201 only says it was accepted. */
    const row = Object.values(res.json)[0];
    for (const [consoleField, kind] of Object.entries(spec.fields)) {
      const column = form.fields[consoleField];
      const stored = (row as Record<string, unknown>)[column];

      if (stored === undefined) {
        failures.push(`${screen}.${consoleField} → ${column}: the response has no such field`);
        continue;
      }
      const empty = stored === null || stored === "" || stored === 0;
      if (empty && kind !== "num") {
        failures.push(
          `${screen}.${consoleField} → ${column}: sent ` +
          `${JSON.stringify(body[consoleField])}, stored ${JSON.stringify(stored)}. ` +
          `The form would look as though it saved and the value would be gone.`);
      }
    }
  }

  assert.deepEqual(failures, [],
    `${failures.length} of the product's 27 forms do not work against this API:\n  ` +
    failures.join("\n  "));
});

/* ====================================================================== *
 * THE FORMS THIS SERVICE ADDS BEYOND THE CONTRACT'S 27.
 *
 * Every test above iterates FORMS, which is read out of §2 of backend.md. So
 * a form added to console-map.js that §2 does not list is checked by NOTHING
 * — not that its resource exists, not that its fields are writable, not that
 * a post survives the round trip. It ships as a ＋ button nobody proved.
 *
 * That is exactly how `pm_assets` and `pm_vendors` arrived: the assets
 * resource had been served since the registry was written with no screen
 * reading it, and vendors are parties nobody had narrowed. Both are real
 * additions to the product rather than contract drift, and the contract is
 * the built frontend's record rather than a ceiling.
 *
 * So they are held to the same standard here, by the same means.
 * ====================================================================== */

/**
 * A REAL id of a row this company owns, for an `id:` field.
 *
 * Made rather than invented, because the framework checks that a reference
 * belongs to the caller's company before writing it — a made-up id is refused
 * with "does not name anything this company has", which is the guard working.
 * A test that fed it a string would be testing the guard and reporting it as a
 * broken form.
 *
 * One row per model, reused: these exist to be pointed at.
 */
const madeRows = new Map();
async function referenceTo(model: Wire) {
  if (madeRows.has(model)) return madeRows.get(model);

  const entry = Object.entries(RESOURCES).find(([, r]) => r.model === model);
  if (!entry) {
    /*
     * A REFERENCE TO A MODEL NO RESOURCE OWNS.
     *
     * The framework allows it: checkReferences falls back to the model name
     * and looks the row up directly, scoped to the company like everything
     * else. `id:parcel` is the first — a Parcel is the AUTHORITY's record of
     * a piece of land, reached through the Property DNA routes rather than
     * through a staff resource, and an acquisition points at one rather than
     * keeping its own copy of somebody else's land registry.
     *
     * So the row is made directly here, the same way the framework reads it.
     * Asserting instead would have failed a reference the service handles
     * perfectly well, and the fix would have been to delete the link.
     */
    assert.ok(db[model], `"${model}" is neither a resource nor a model — id: names nothing`);
    const made = await db[model].create({
      data: { orgId: present(ORG, "no company was made").id, ref: `REF-${++unique}` },
    });
    madeRows.set(model, made.id);
    return made.id;
  }
  const [slug, resource] = entry;

  const body: Record<string, unknown> = {};
  for (const name of resource.required || []) {
    const kind = resource.fields[name];
    /* A required field can itself be a reference — a project phase needs a
       project. Recursing is the only way to build the chain, and the cache
       above stops it looping on a resource that referenced itself. */
    body[name] = kind.startsWith("id:")
      ? await referenceTo(kind.slice(3))
      : valueForKind(kind, name);
  }
  const res = await post(`/${slug}`, body);
  assert.equal(res.status, 201,
    `could not create a ${model} to point at: ${res.status} ${res.text.slice(0, 160)}`);

  const id = (Object.values(res.json)[0] as Wire).id;
  madeRows.set(model, id);
  return id;
}

/** A value the console would send, chosen from the REGISTRY's field kind. */
function valueForKind(kind: Wire, field: Wire) {
  if (kind.startsWith("enum:")) {
    const values = enumValues(kind.slice(5));
    /* The wording the server will actually take. A form offering a value the
       enum does not hold is the bug this file exists to catch, so a missing
       enum is a failure rather than a skip. */
    assert.ok(values && values.length, `${kind} has no values in the generated client`);
    return values[0];
  }
  if (kind === "int" || kind === "money" || kind === "float") return 4;
  /*
   * NEGATIVE ON PURPOSE. `signed-money` exists for amounts that can go both
   * ways — a variation that omits a balcony reduces a contract — so sending a
   * positive one here would test the half that `money` already covers and
   * leave the half this kind was added for untested.
   */
  if (kind === "signed-money") return -4;
  if (kind === "bool") return true;
  if (kind === "date") return "Mar 2024";
  unique += 1;
  return `Console ${field} ${unique}`;
}

/** The enum's values, from the generated client rather than a copy. */
function enumValues(name: string): string[] | null {
  /* The name arrives as a string off a field kind ("enum:LeaseStatus"), so
     there is nothing at compile time to key the module's shape by. */
  const bag = prismaPkg as unknown as Record<string, unknown>;
  const nested = bag["Prisma"] as Record<string, unknown> | undefined;
  const e = bag[name] ?? nested?.[name];
  return e && typeof e === "object" ? Object.keys(e) : null;
}

const EXTRA_FORMS = Object.entries(CONSOLE_FORMS).filter(([screen]) => !(screen in FORMS));

test("this service adds forms the contract does not list, and they are real", { skip }, () => {
  /* If this ever reads zero, the two tests below are passing by iterating
     nothing — the same trap "the role table is not quietly empty" guards. */
  assert.ok(EXTRA_FORMS.length > 0,
    "no forms beyond §2's 27 — if that is deliberate, delete these three tests");

  const problems = [];
  for (const [screen, form] of EXTRA_FORMS) {
    const resource = RESOURCES[form.resource];
    if (!resource) {
      problems.push(`${screen} → "${form.resource}", which is not a resource`);
      continue;
    }
    for (const [consoleField, column] of Object.entries(form.fields)) {
      if (!resource.fields[column]) {
        problems.push(
          `${screen}.${consoleField} → "${column}", which "${form.resource}" does not ` +
          `declare as a writable field — the server would drop it silently`);
      }
    }
  }
  assert.deepEqual(problems, [], "Forms added beyond the contract:\n  " + problems.join("\n  "));
});

test("every form beyond the 27 posts, and nothing is silently dropped", { skip }, async () => {
  const failures = [];

  for (const [screen, form] of EXTRA_FORMS) {
    const resource = RESOURCES[form.resource];
    if (!resource) continue;

    const body: Record<string, unknown> = {};
    for (const [consoleField, column] of Object.entries(form.fields)) {
      const kind = resource.fields[column];
      body[consoleField] = kind.startsWith("id:")
        ? await referenceTo(kind.slice(3))
        : valueForKind(kind, consoleField);
    }

    const res = await post(`/${form.resource}`, body);
    if (res.status !== 201) {
      failures.push(`${screen} → POST /${form.resource} answered ${res.status}: ${res.text.slice(0, 220)}`);
      continue;
    }

    /* 201 only says it was accepted. */
    const row = Object.values(res.json)[0];
    for (const [consoleField, column] of Object.entries(form.fields)) {
      const stored = (row as Record<string, unknown>)[column];
      if (stored === undefined) {
        failures.push(`${screen}.${consoleField} → ${column}: the response has no such field`);
        continue;
      }
      if (stored === null || stored === "") {
        failures.push(
          `${screen}.${consoleField} → ${column}: sent ${JSON.stringify(body[consoleField])}, ` +
          `stored ${JSON.stringify(stored)}. The form would look as though it saved.`);
      }
    }
  }

  assert.deepEqual(failures, [],
    `forms added beyond the contract that do not work against this API:\n  ` + failures.join("\n  "));
});

test("the enum wording the console offers is wording the server accepts", { skip }, async () => {
  /*
   * Each dropdown, every option, not just the first. A console that offers
   * "Needs work" and a server that only takes NEEDS_WORK is a form that
   * fails for one choice out of three, which is the kind of bug that gets
   * reported as "it sometimes doesn't save".
   */
  const failures = [];

  for (const [screen, spec] of Object.entries(FORMS)) {
    const form = CONSOLE_FORMS[screen];
    if (!form) continue;

    for (const [consoleField, kind] of Object.entries(spec.fields)) {
      if (!kind.startsWith("enum(")) continue;
      const column = form.fields[consoleField];
      const declared = RESOURCES[form.resource].fields[column] || "";
      if (!declared.startsWith("enum:")) continue;      // stored as free text

      for (const option of kind.slice(5, -1).split("|").map((s: Wire) => s.trim())) {
        const body: Record<string, unknown> = {};
        for (const [f, k] of Object.entries(spec.fields)) body[f] = valueFor(f, k);
        body[consoleField] = option;
        if (form.resource === "zones") {
      body["siteId"] = present(SITE, "no site was made").json.site.id;
    }

        const res = await post(`/${form.resource}`, body);
        if (res.status !== 201) {
          failures.push(`${screen}: the option "${option}" was refused — ` +
                        `${res.status} ${res.text.slice(0, 150)}`);
          continue;
        }
        const stored = (Object.values(res.json)[0] as Wire)[column];
        const want = option.toUpperCase().replace(/[\s-]+/g, "_");
        if (stored !== want && stored !== option) {
          /* Not necessarily wrong — console-map.js translates some wordings
             deliberately — but it must have landed on SOMETHING real. */
          const values = declared.slice(5);
          assert.ok(typeof stored === "string" && stored.length,
            `${screen}: "${option}" stored as ${JSON.stringify(stored)} in ${values}`);
        }
      }
    }
  }

  assert.deepEqual(failures, [],
    "Dropdown options the console offers and the server refuses:\n  " + failures.join("\n  "));
});

test("a blank date is stored as no date, not as the epoch", { skip }, async () => {
  /*
   * The console prints "—" where a document has no expiry, and a form left
   * blank sends something like it. `new Date("—")` is Invalid, and a naive
   * implementation either stores garbage or 400s on an empty optional field.
   */
  for (const blank of ["—", "", "n/a", "TBC"]) {
    const res = await post("/documents", { n: `Deed ${blank || "blank"}`, kind: "Ownership", exp: blank });
    assert.equal(res.status, 201, `exp: ${JSON.stringify(blank)} → ${res.text.slice(0, 160)}`);
    assert.equal(res.json.document.expiresAt, null,
      `exp: ${JSON.stringify(blank)} was stored as ${res.json.document.expiresAt}`);
  }

  /* And real nonsense is still refused, rather than quietly becoming null. */
  const bad = await post("/documents", { n: "Deed", kind: "Ownership", exp: "whenever" });
  assert.equal(bad.status, 400, "a date nobody can read was accepted");
  assert.match(bad.json.message, /not a date/);
});

test("a date written the console's way lands in the right year", { skip }, async () => {
  /*
   * THE ONE THAT WOULD HAVE BEEN FOUND BY A CUSTOMER.
   *
   *     new Date("9 Sep")  →  2001-09-09
   *
   * JavaScript parses it happily, into a year a quarter of a century in the
   * past. A booking taken for next week would be filed in 2001 with no error
   * anywhere at all.
   */
  const res = await post("/reservations", { g: "N. Chebet", inn: "9 Sep", n: 4, total: 37600 });
  assert.equal(res.status, 201, res.text);

  const arrive = new Date(res.json.reservation.arriveOn);
  assert.equal(arrive.getUTCFullYear(), new Date().getUTCFullYear(),
    `"9 Sep" was stored as ${res.json.reservation.arriveOn} — the year is wrong`);
  assert.equal(arrive.getUTCMonth(), 8, "September is month 8");
  assert.equal(arrive.getUTCDate(), 9);
});
