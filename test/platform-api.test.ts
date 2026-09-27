/* ====================================================================== *
 * THE PALTAS STAFF CONSOLE, AND THE WALL IT IS ALLOWED THROUGH.
 *
 * This is the only file in the service that reads across tenants. So these
 * are not "does it work" tests — they are tests that the door is narrow:
 * who may open it, what comes through it, and whether anybody can tell it is
 * there.
 *
 * The failure being prevented: a customer's OWNER finding that being an owner
 * of their company makes them an owner of ours.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { freshSchema, poolInSchema, urlForSchema } from "./db-help.ts";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.ts";
import { portOf, present } from "./wire.ts";
import type { CallOptions, Reply, Wire } from "./wire.ts";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const SCHEMA = "test_platform";
process.env.DATABASE_URL =
  DB ? urlForSchema(DB, SCHEMA) : "postgresql://unused@127.0.0.1:1/none";
process.env.SESSION_SECRET ||= "test-secret-that-is-long-enough-to-pass";
process.env.GOOGLE_CLIENT_ID ||= "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "test-client-secret";
process.env.PUBLIC_URL ||= "http://127.0.0.1:8080";
process.env.APP_URL ||= "http://127.0.0.1:8899";
process.env.INSECURE_COOKIES = "1";

let skip = DB ? false : "no TEST_DATABASE_URL — skipping platform console tests";
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
let createApp: typeof import("../src/server.ts")["createApp"];
let db: typeof import("../src/db.ts")["db"];
let pg: typeof import("pg")["default"];

if (!skip) {
  try {
    ({ default: pg } = await import("pg"));
    ({ db } = await import("../src/db.ts"));
    ({ createApp } = await import("../src/server.ts"));
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    skip = /did not initialize|locate the Query Engine|generate/.test(m)
      ? "RUN `npx prisma generate` FIRST" : "database unreachable: " + m.slice(0, 90);
  }
}

let server: import("node:http").Server;
let base: string;
let pool: import("pg").Pool;
test.before(async () => {
  if (skip) return;
  pool = poolInSchema(pg, DB, SCHEMA);
  await freshSchema(pool, SCHEMA);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${portOf(server)}`;
});
test.after(async () => { if (server) server.close(); if (pool) await pool.end(); });

async function call(
  path: string, { method = "GET", body, cookie }: CallOptions = {},
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
               ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

let seq = 0;

async function company({ products, role, name }: {
    products: readonly string[];
    role?: import("@prisma/client").$Enums.Role;
    name?: string;
  }) {
  const n = ++seq;
  const org = await db.organization.create({
    data: { name: name || `Company ${n}`, country: "ke",
      subscription: { create: { status: "ACTIVE", plan: "Pro", seats: 5 } },
      verification: { create: { status: "COMPLETE" } },
      workspace: { create: { status: "ACTIVE" } },
      entitlements: { create: products.map((p: Wire) => ({ product: p })) } },
  });
  const email = `u${n}-${Date.now()}@t.test`;
  const user = await db.user.create({
    data: { email, name: `User ${n}`, phone: "+254700000000", googleSub: `sub${n}-${Date.now()}` },
  });
  await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({
    data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
            userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return { org, user, cookie: `paltas_session=${token}` };
}

const PATHS = ["/platform/organizations", "/platform/users", "/platform/entitlements",
               "/platform/audit", "/platform/summary",
               /* The four the console's remaining screens needed. Added to
                  PATHS rather than tested separately, so every existing check
                  in this file — the refusal, the audit trail, the staff-role
                  requirement — applies to them automatically. A new endpoint
                  that skips the door is the bug this prevents. */
               "/platform/moderation", "/platform/compliance",
               "/platform/verifications", "/platform/plans"];

/* ================================================================ */

test("owning YOUR company grants nothing on OURS", { skip }, async () => {
  /* The whole point of the console being a separate door. An OWNER with every
     customer product is still a customer. */
  const customer = await company({
    products: ["PROPERTY_MANAGEMENT", "HOTEL_MANAGEMENT", "AGENT_HOST", "SECURITY_MANAGEMENT"],
    role: "OWNER",
  });
  for (const p of PATHS) {
    const r = await call(p, { cookie: customer.cookie });
    assert.equal(r.status, 403, `a customer OWNER reached ${p}`);
  }
});

test("an unsigned-in caller gets 401, not a hint", { skip }, async () => {
  for (const p of PATHS) {
    const r = await call(p);
    assert.equal(r.status, 401, `${p} answered ${r.status} without a session`);
  }
});

test("the refusal says the same thing whatever the reason", { skip }, async () => {
  /*
   * A caller probing this console must learn only that it is not for them.
   * "You need the PLATFORM entitlement" tells somebody exactly what to go
   * looking for — so the wrong entitlement and the wrong role read alike.
   */
  const noEntitlement = await company({ products: ["HOTEL_MANAGEMENT"], role: "OWNER" });
  const wrongRole = await company({ products: ["PLATFORM"], role: "GUARD" });

  const a = await call("/platform/organizations", { cookie: noEntitlement.cookie });
  const b = await call("/platform/organizations", { cookie: wrongRole.cookie });
  assert.equal(a.status, 403);
  assert.equal(b.status, 403);
  assert.equal(a.json.message, b.json.message,
    "the two refusals differ, which tells a prober which half they got wrong");
  assert.doesNotMatch(a.json.message, /entitlement|role|PLATFORM/i,
    "the refusal names what is missing");
});

test("a PLATFORM holder with a staff role sees every customer", { skip }, async () => {
  await company({ products: ["HOTEL_MANAGEMENT"], role: "OWNER", name: "Marina Vista Hotels" });
  await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER", name: "Alma Real Estate" });
  const staff = await company({ products: ["PLATFORM"], role: "MARKETING", name: "PALTAS" });

  const r = await call("/platform/organizations", { cookie: staff.cookie });
  assert.equal(r.status, 200, r.text);
  const names = r.json.organizations.map((o: Wire) => o.name);
  assert.ok(names.includes("Marina Vista Hotels"), "a customer is missing");
  assert.ok(names.includes("Alma Real Estate"), "a customer is missing");

  const hotel = r.json.organizations.find((o: Wire) => o.name === "Marina Vista Hotels");
  assert.deepEqual(hotel.products, ["HOTEL_MANAGEMENT"]);
  assert.equal(hotel.subscription.status, "ACTIVE");
  assert.equal(hotel.verification, "COMPLETE");
});

test("staff get COUNTS of a customer's records, never the records", { skip }, async () => {
  const customer = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
                                   name: "Counted Ltd" });
  await db.site.create({ data: { orgId: customer.org.id, name: "Riverside Court",
                                 value: 96_000_000_000n } });
  await db.unit.create({ data: { orgId: customer.org.id, ref: "RC-12B", rent: 14_200_000n } });

  const staff = await company({ products: ["PLATFORM"], role: "COMPLIANCE" });
  const r = await call("/platform/organizations?q=Counted", { cookie: staff.cookie });
  const row = r.json.organizations.find((o: Wire) => o.name === "Counted Ltd");

  assert.equal(row.counts.sites, 1);
  assert.equal(row.counts.units, 1);
  /*
   * AND NOT WHAT IS IN THEM. A support console that returns a customer's site
   * names and valuations is a back door with a nicer label.
   */
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes("Riverside Court"), "a customer's site name came through");
  assert.ok(!body.includes("96000000000"), "a customer's valuation came through");
  assert.ok(!body.includes("RC-12B"), "a customer's unit reference came through");
});

test("the user list carries memberships, not personal details", { skip }, async () => {
  const customer = await company({ products: ["HOTEL_MANAGEMENT"], role: "GM",
                                   name: "Personal Details Ltd" });
  const staff = await company({ products: ["PLATFORM"], role: "PUBLISHER" });

  const r = await call("/platform/users", { cookie: staff.cookie });
  assert.equal(r.status, 200);
  const them = r.json.users.find((u: Wire) => u.email === customer.user.email);
  assert.ok(them, "the customer's user is missing");
  assert.equal(them.memberships[0].organizationName, "Personal Details Ltd");
  assert.equal(them.memberships[0].role, "GM");

  /* Support does not need to ring a customer's staff, and a Google subject
     claim is an identifier for Google's benefit. */
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes("+254700000000"), "a user's phone number came through");
  assert.ok(!/googleSub|sub\d+-/.test(body), "a Google subject claim came through");
});

test("the audit list shows that something happened, not what was in it", { skip }, async () => {
  const customer = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  /* A real write, which records a `detail` containing the customer's fields. */
  await call("/sites", { method: "POST", cookie: customer.cookie,
                         body: { name: "Secret Tower", value: 1_000_000 } });

  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const r = await call("/platform/audit", { cookie: staff.cookie });
  assert.equal(r.status, 200);
  const created = r.json.events.find((e: Wire) => e.action === "create" && e.entity === "site");
  assert.ok(created, "the customer's write is not in the log");
  assert.ok(created.who, "the log does not say who");
  assert.equal("detail" in created, false,
    "the audit list returns `detail`, which carries the customer's own field values");
});

test("every read is audited, naming the member of staff", { skip }, async () => {
  /*
   * "Who looked at whose data" has to be answerable without anybody's
   * cooperation. Written against PALTAS's own organization, so a customer's
   * trail does not fill with our support activity.
   */
  const staff = await company({ products: ["PLATFORM"], role: "MARKETING", name: "PALTAS Audit" });
  const before = await db.auditEvent.count({ where: { orgId: staff.org.id } });

  for (const p of PATHS) await call(p, { cookie: staff.cookie });

  const after = await db.auditEvent.findMany({
    where: { orgId: staff.org.id, action: "platform.read" },
    select: { entity: true, actorId: true, actorName: true },
  });
  assert.ok(after.length >= PATHS.length,
    `${PATHS.length} reads produced ${after.length} audit rows`);
  assert.equal(after[0].actorId, staff.user.id);
  assert.ok(after[0].actorName, "the audit row does not name the member of staff");
  assert.ok(after.length > before, "nothing was written");
});

test("the console is read-only — it cannot change a customer's business", { skip }, async () => {
  /* Supporting a customer means seeing what they see, not changing it behind
     them. The promotion queues are the one place staff act, and they have
     their own routes and their own rights table. */
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  for (const p of PATHS) {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const r = await call(p, { method, cookie: staff.cookie, body: { name: "x" } });
      assert.ok(r.status === 404 || r.status === 401 || r.status === 403,
        `${method} ${p} answered ${r.status} — the console is meant to be read-only`);
    }
  }
});

test("it never reaches the resource framework", { skip }, async () => {
  /*
   * THE STRUCTURAL GUARANTEE, asserted on the source.
   *
   * The alternative design was to make the organization filter in
   * http/resource.js conditional on holding PLATFORM. That would turn the one
   * line this product's promise rests on into an `if`. This asserts the
   * separation is real and not just intended.
   */
  const { readFileSync } = await import("node:fs");
  const src = sourceText("routes", "platform.js");
  for (const forbidden of ["resourceRouter", "RESOURCES", "domain/registry"]) {
    assert.ok(!src.includes(forbidden),
      `routes/platform.js references ${forbidden} — the cross-tenant console must not ` +
      `go through the org-scoped framework`);
  }
  const framework = sourceText("http", "resource.js");
  assert.ok(!/isPlatform|PLATFORM/.test(framework),
    "http/resource.js knows about PLATFORM — the organization filter has been made " +
    "conditional, which is the design this console exists to avoid");
});

test("paging is capped, however large a limit is asked for", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER" });
  const r = await call("/platform/organizations?limit=100000", { cookie: staff.cookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.organizations.length <= 200, "the cap can be raised by asking");
});

/* ================================================================ *
 * THE FOUR NEW QUEUES.
 * ================================================================ */

test("the moderation queue names the company, never the listing's contents",
  { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "COMPLIANCE", name: "PALTAS" });
  const cust = await company({ products: ["AGENT_HOST"], role: "OWNER", name: "Fast Lets" });

  const listing = await db.listing.create({
    data: { orgId: cust.org.id, title: "3-bed apartment, Kilimani",
            price: 9_500_000n, currency: "KES" },
  });
  await db.moderationItem.create({
    data: { orgId: cust.org.id, listingId: listing.id,
            title: "3-bed apartment, Kilimani",
            reason: "Photographs taken from another listing", severity: "HIGH" },
  });

  const r = await call("/platform/moderation", { cookie: staff.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.items.length, 1);
  const it = r.json.items[0];
  assert.equal(it.organizationName, "Fast Lets");
  assert.equal(it.severity, "HIGH");
  assert.equal(it.status, "WAITING");
  assert.equal(it.listingId, listing.id, "the queue must say WHICH listing");
  /* The listing's own fields are the customer's copy. Knowing which listing is
     held is the queue's job; reading its price is not. */
  assert.ok(!JSON.stringify(r.json).includes("9500000"), "the listing's price leaked");

  /* And a customer cannot read the queue at all, not even their own row. */
  const denied = await call("/platform/moderation", { cookie: cust.cookie });
  assert.equal(denied.status, 403, "a customer read the moderation queue");
});

test("a compliance case carries its clock, and only staff see it", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "COMPLIANCE", name: "PALTAS" });
  const cust = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });
  const due = new Date(Date.now() + 21 * 86400_000);
  await db.complianceCase.create({
    data: { orgId: cust.org.id, ref: "C-2209", kind: "Data request",
            subject: "Grace Wanjiru",
            detail: "Asked for every record held about her", dueOn: due },
  });

  const r = await call("/platform/compliance", { cookie: staff.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.cases.length, 1);
  assert.equal(r.json.cases[0].ref, "C-2209");
  assert.equal(r.json.cases[0].status, "OPEN");
  assert.ok(r.json.cases[0].dueOn, "a statutory case with no due date is unworkable");

  assert.equal((await call("/platform/compliance", { cookie: cust.cookie })).status, 403);
});

test("the verification queue says what KIND of document, never the document",
  { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "COMPLIANCE", name: "PALTAS" });
  const waiting = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER",
                                  name: "Coastal Homes Mombasa" });
  await db.verification.update({
    where: { orgId: waiting.org.id },
    data: {
      status: "PENDING",
      documents: [
        { kind: "identity", url: "https://files.example/passport-scan.pdf" },
        { kind: "ownership", url: "https://files.example/title-deed.pdf" },
      ],
    },
  });

  const r = await call("/platform/verifications?status=PENDING", { cookie: staff.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const row = r.json.queue.find((q: Wire) => q.organizationName === "Coastal Homes Mombasa");
  assert.ok(row, "the company waiting for approval is not in the queue");
  assert.deepEqual(row.documentKinds, ["identity", "ownership"]);
  assert.equal(row.documentCount, 2);
  assert.ok(row.contactName, "a queue with nobody to contact cannot be worked");

  /*
   * THE FILES THEMSELVES DO NOT LEAVE.
   *
   * A passport scan is not something a support queue needs in order to say
   * "identity is still outstanding".
   */
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes("passport-scan"), "a document URL leaked");
  assert.ok(!body.includes("title-deed"), "a document URL leaked");
  assert.ok(!/https?:\/\//.test(body), "the queue returned a URL of some kind");
});

test("the price list is the same for everybody, and has no company", { skip }, async () => {
  const staff = await company({ products: ["PLATFORM"], role: "OWNER", name: "PALTAS" });
  await db.plan.createMany({
    data: [
      { code: "basic", name: "Basic", price: 1_800_000n, seq: 1,
        limitText: "Up to 2 properties", propertyCap: 2 },
      { code: "business", name: "Business", price: 6_400_000n, seq: 2,
        limitText: "Up to 10 properties", propertyCap: 10 },
    ],
    skipDuplicates: true,
  });

  const r = await call("/platform/plans", { cookie: staff.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.json.plans.length >= 2);
  const basic = r.json.plans.find((p: Wire) => p.code === "basic");
  assert.equal(basic.price, 1_800_000, "a price list that rounds is not a price list");
  assert.equal(basic.propertyCap, 2);
  /* No orgId anywhere: a plan belongs to nobody, which is what stops a company
     editing the price it is charged. */
  assert.ok(!("organization" in basic) && !("orgId" in basic));
});

/* ==================================================================== *
 * THE ＋ BUTTONS A ROLE IS OFFERED, FROM THE ROUTE ITSELF.
 *
 * GET /console/forms is where the console learns which screens can create
 * something. It listed every form to everybody, so an engineer — who may
 * read the property area but not write it — was offered ＋ on buildings,
 * units, meetings, tasks, RFIs, inspections, defects, the site diary and
 * assets. Nine buttons that open a form, ask for eight fields and are
 * refused on submit. A finance user got a tenth on documents.
 *
 * This asks the ROUTE, not the table it reads. An earlier version of this
 * test recomputed the filter itself and went on passing when the filter
 * was deleted from the handler — which is the whole failure it exists to
 * catch.
 * ==================================================================== */

test("the console is only offered forms its role may actually submit", { skip }, async () => {
  const { RESOURCES } = await import("../src/domain/registry.ts");
  const { whyNotArea } = await import("../src/domain/access.ts");

  const formsFor = async (role: import("@prisma/client").$Enums.Role) => {
    const { cookie } = await company({ products: ["PROPERTY_MANAGEMENT"], role });
    const r = await call("/console/forms", { cookie });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return r.json.forms as Record<string, Wire>;
  };

  const owner = await formsFor("OWNER");
  const ownerCount = Object.keys(owner).length;
  assert.ok(ownerCount > 20,
    `an owner was offered only ${ownerCount} forms — the map has stopped resolving`);

  for (const role of ["ENGINEERING", "FINANCE", "OPERATIONS"] as const) {
    const served = await formsFor(role);
    const wrong: string[] = [];
    for (const [screen, form] of Object.entries(served)) {
      const declared = RESOURCES[String(form.resource)];
      if (!declared) continue;
      const why = whyNotArea({ role }, declared.area, "create", declared.area);
      if (why) wrong.push(`${screen} -> ${form.resource} (${declared.area}): ${why}`);
    }
    assert.deepEqual(wrong, [],
      `/console/forms offered ${role} a ＋ button the service refuses. Every one ` +
      `of these opens a form and is rejected on submit:\n    ` + wrong.join("\n    "));

    assert.ok(Object.keys(served).length < ownerCount,
      `${role} was offered the same ${ownerCount} forms an owner is, so the ` +
      `permission filter on /console/forms is not doing anything at all`);
  }
});

/* ==================================================================== *
 * A REFUSED ATTEMPT AT THE STAFF CONSOLE LEAVES A TRACE.
 *
 * The door refused correctly and said nothing to anybody. An account
 * trying every /platform/* endpoint in turn was invisible, and the first
 * anyone would have known of it is the one that eventually worked.
 *
 * A refusal is the more interesting of the two events: a successful staff
 * read is somebody doing their job, a refused one is either a stale tab or
 * somebody finding out what is behind the wall — and telling those apart
 * needs both written down.
 * ==================================================================== */

test("a customer refused the staff console is recorded", { skip }, async () => {
  const cust = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const tried = await call("/platform/organizations", { cookie: cust.cookie });
  assert.equal(tried.status, 403, "a customer reached the staff console");

  const trail = await db.auditEvent.findMany({
    where: { orgId: cust.org.id, action: "platform.refused" },
  });
  assert.equal(trail.length, 1,
    "*** somebody tried the PALTAS staff console and left no trace. An account " +
    "working through every /platform endpoint in turn would be invisible. ***");

  const row = present(trail[0], "no row");
  assert.equal(row.actorName, cust.user.name || cust.user.email,
    "the trail should name who tried");
  assert.match(String((row.detail as Wire)?.path), /platform\/organizations/,
    "the trail should say what they tried to open");
  assert.match(String((row.detail as Wire)?.why), /not a PALTAS staff account/,
    "the reason is recorded even though it is deliberately not said out loud");
});

test("the caller still learns nothing from the refusal", { skip }, async () => {
  const cust = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  const tried = await call("/platform/organizations", { cookie: cust.cookie });
  assert.match(String(tried.json.message), /not available to this account/);
  assert.doesNotMatch(String(tried.text), /PLATFORM|entitlement|staff role/i,
    "*** the refusal told a prober exactly what to go looking for ***");
});

test("every refused endpoint is recorded, not only the first", { skip }, async () => {
  const cust = await company({ products: ["PROPERTY_MANAGEMENT"], role: "OWNER" });

  for (const path of ["/platform/organizations", "/platform/users", "/platform/entitlements"]) {
    assert.equal((await call(path, { cookie: cust.cookie })).status, 403);
  }

  const trail = await db.auditEvent.findMany({
    where: { orgId: cust.org.id, action: "platform.refused" },
  });
  assert.equal(trail.length, 3,
    "working along the endpoints one by one is the shape of probing, and it is " +
    "only visible if each attempt is written down");
  assert.equal(
    new Set(trail.map((e) => String((e.detail as Wire)?.path))).size, 3,
    "the trail should say which endpoints were tried, not merely how many times");
});

test("a refusal that cannot be attributed is not filed under somebody else", { skip }, async () => {
  /* No cookie at all: there is no organization to write the row against, and
     inventing one would put a stranger's act in a customer's trail. */
  const before = await db.auditEvent.count({ where: { action: "platform.refused" } });
  const tried = await call("/platform/organizations");
  assert.ok(tried.status === 401 || tried.status === 403, `got ${tried.status}`);

  const after = await db.auditEvent.count({ where: { action: "platform.refused" } });
  assert.equal(after, before,
    "an unattributable refusal was filed against somebody's organization");
});
