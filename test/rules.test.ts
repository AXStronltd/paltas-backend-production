/* ====================================================================== *
 * THE RULES.
 *
 * Every decision that matters is a pure function, on purpose, so that it can
 * be tested exhaustively without a database, a session or a network:
 *
 *   who may do what            domain/rights.js
 *   what may follow what       domain/promotions.js  TRANSITIONS
 *   what the world may see     domain/promotions.js  isPubliclyVisible
 *   what a check says          domain/promotions.js  contentCheck / creativeCheck
 *   what a request may set     domain/promotions.js  cleanPromotionInput
 *
 * These are the tests that would catch the bugs worth catching. A route that
 * forgets to call one of them is a wiring mistake; a rule that is wrong is a
 * customer's draft on the homepage.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROMOTION_RIGHTS, can, promotionRights, subscriptionOpens,
  verificationRestricts, whyNot,
} from "../src/domain/rights.ts";

import {
  CREATIVE_RULES, PUBLIC_STATES, TRANSITIONS, cleanPromotionInput,
  contentCheck, creativeCheck, isPubliclyVisible, isPublicState,
  publicWhere, toPublicWire, toWire,
} from "../src/domain/promotions.ts";
import type { Wire } from "./wire.ts";

const ALL_STATES = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "RESUBMITTED",
  "MARKETING_APPROVED", "FINAL_APPROVED", "SCHEDULED", "PUBLISHED",
  "PAUSED", "EXPIRED", "REJECTED",
];

const actor = (over = {}) => ({
  userId: "u1", userName: "Somebody", orgId: "o1", orgName: "A company",
  role: "OWNER", scope: { all: true }, products: ["HOTEL_MANAGEMENT"],
  isPlatform: false, subscriptionStatus: "ACTIVE", verificationStatus: "COMPLETE",
  ...over,
});

/* ================================================================ */
test("exactly one state is public, and it is PUBLISHED", () => {
  assert.equal(PUBLIC_STATES.size, 1);
  assert.ok(PUBLIC_STATES.has("PUBLISHED"));
  for (const s of ALL_STATES) {
    assert.equal(isPublicState(s), s === "PUBLISHED", `${s} answered the wrong way`);
  }
});

test("no state other than PUBLISHED is ever publicly visible", () => {
  const base = {
    headline: "A headline", ctaLabel: "Book",
    startDate: new Date("2020-01-01"), endDate: new Date("2999-01-01"),
  };
  const today = new Date("2026-09-11");
  for (const status of ALL_STATES) {
    const visible = isPubliclyVisible({ ...base, status }, today);
    assert.equal(visible, status === "PUBLISHED",
      `${status} should ${status === "PUBLISHED" ? "" : "not "}be visible`);
  }
});

test("a published promotion is invisible outside its dates, both ways", () => {
  const p = (from: Wire, to: Wire) => ({
    status: "PUBLISHED", headline: "h", ctaLabel: "c",
    startDate: new Date(from), endDate: new Date(to),
  });
  const on = (d: Wire) => new Date(d);

  assert.equal(isPubliclyVisible(p("2026-10-01", "2026-10-31"), on("2026-09-30")), false,
    "visible the day before it starts");
  assert.equal(isPubliclyVisible(p("2026-10-01", "2026-10-31"), on("2026-10-01")), true,
    "not visible on its first day");
  assert.equal(isPubliclyVisible(p("2026-10-01", "2026-10-31"), on("2026-10-31")), true,
    "not visible on its last day");
  assert.equal(isPubliclyVisible(p("2026-10-01", "2026-10-31"), on("2026-11-01")), false,
    "still visible the day after it ends");
});

test("a promotion with nothing to show is not shown", () => {
  const today = new Date("2026-09-11");
  const ok = { status: "PUBLISHED", headline: "h", ctaLabel: "c" };
  assert.equal(isPubliclyVisible(ok, today), true);
  assert.equal(isPubliclyVisible({ ...ok, headline: "" }, today), false, "no headline");
  assert.equal(isPubliclyVisible({ ...ok, ctaLabel: "" }, today), false, "no button");
  assert.equal(isPubliclyVisible(null, today), false);
  assert.equal(isPubliclyVisible(undefined, today), false);
});

test("the public query asks for PUBLISHED and nothing else", () => {
  const w = publicWhere(new Date("2026-09-11"));
  assert.equal(w.status, "PUBLISHED",
    "the database query itself must narrow to PUBLISHED, not just the filter after it");
});

/* ================================================================ */
test("the publish wall: marketing approves, only a publisher publishes", () => {
  const marketing = actor({ role: "MARKETING" });
  const publisher = actor({ role: "PUBLISHER" });
  const compliance = actor({ role: "COMPLIANCE" });

  assert.equal(can(marketing, "approveMarketing"), true);
  assert.equal(can(marketing, "publish"), false, "MARKETING could publish");
  assert.equal(can(marketing, "schedule"), false);
  assert.equal(can(marketing, "finalQueue"), false);

  assert.equal(can(publisher, "publish"), true);
  assert.equal(can(publisher, "schedule"), true);
  assert.equal(can(publisher, "pause"), true);

  /* Compliance is the interesting one: it can send anything back and approve
     nothing at all. That is the whole reason it exists as a separate role. */
  assert.equal(can(compliance, "requestChanges"), true);
  assert.equal(can(compliance, "approveMarketing"), false, "COMPLIANCE could approve");
  assert.equal(can(compliance, "publish"), false, "COMPLIANCE could publish");
});

test("a customer, of any role, can never publish", () => {
  for (const role of ["OWNER", "MANAGER", "GM", "LEASING", "HOST", "PROMO_CONTRIBUTOR"]) {
    const a = actor({ role });
    assert.equal(can(a, "publish"), false, `${role} could publish`);
    assert.equal(can(a, "approveMarketing"), false, `${role} could approve`);
    assert.equal(can(a, "queue"), false, `${role} could read the queue`);
  }
});

test("owning YOUR company grants nothing on OURS", () => {
  const hotelOwner = actor({ role: "OWNER", isPlatform: false });
  assert.equal(can(hotelOwner, "publish"), false,
    "the owner of a customer company could publish to the PALTAS homepage");

  /* The elevation is conditional on the PLATFORM entitlement, never on the
     role alone — which is exactly the wall the product sells. */
  const paltasOwner = actor({ role: "OWNER", isPlatform: true, products: ["PLATFORM"] });
  assert.equal(can(paltasOwner, "publish"), true);
  assert.equal(promotionRights(paltasOwner), PROMOTION_RIGHTS.PUBLISHER);
});

test("a role nobody has heard of can do nothing", () => {
  const a = actor({ role: "SOMETHING_INVENTED" });
  for (const act of ["create", "submit", "queue", "publish", "approveMarketing"]) {
    assert.equal(can(a, act), false, `an unknown role could ${act}`);
  }
});

test("a narrow contributor can write and submit and nothing more", () => {
  const a = actor({ role: "PROMO_CONTRIBUTOR" });
  assert.equal(can(a, "create"), true);
  assert.equal(can(a, "editOwn"), true);
  assert.equal(can(a, "submit"), true);
  assert.equal(can(a, "editOrg"), false, "a contributor could edit a colleague's promotion");
  assert.equal(can(a, "publish"), false);
});

/* ================================================================ */
test("PAST_DUE still opens the console; CANCELED and EXPIRED do not", () => {
  assert.equal(subscriptionOpens("TRIALING"), true);
  assert.equal(subscriptionOpens("ACTIVE"), true);
  assert.equal(subscriptionOpens("PAST_DUE"), true, "a late invoice locked somebody out");
  assert.equal(subscriptionOpens("CANCELED"), false);
  assert.equal(subscriptionOpens("EXPIRED"), false);
  assert.equal(subscriptionOpens("NONSENSE"), false);
});

test("a past-due company can still do its work", () => {
  const a = actor({ subscriptionStatus: "PAST_DUE" });
  assert.equal(whyNot(a, "create"), null, "PAST_DUE blocked an ordinary action");
});

test("a canceled company is refused, and told nothing was deleted", () => {
  const a = actor({ subscriptionStatus: "CANCELED" });
  const why = whyNot(a, "create");
  assert.ok(why, "CANCELED was allowed through");
  assert.match(why, /nothing has been deleted/i,
    "the refusal should say the data is still there");
});

test("verification restricts publish and payout, and nothing else", () => {
  assert.deepEqual(
    ["publish", "payout", "read", "create", "submit"].filter(
      (act) => verificationRestricts("NOT_STARTED", act)),
    ["publish", "payout"]);

  /* PENDING restricts only payout — somebody who has supplied their documents
     and is waiting can get on with publishing. */
  assert.equal(verificationRestricts("PENDING", "publish"), false);
  assert.equal(verificationRestricts("PENDING", "payout"), true);

  assert.equal(verificationRestricts("COMPLETE", "publish"), false);
  assert.equal(verificationRestricts("COMPLETE", "payout"), false);

  /* An unknown status is treated as the strictest, not the loosest. */
  assert.equal(verificationRestricts("WHO_KNOWS", "publish"), true);
});

test("an unverified company can do everything except publish", () => {
  const a = actor({ role: "PUBLISHER", isPlatform: true, verificationStatus: "NOT_STARTED" });
  assert.equal(whyNot(a, "queue"), null, "verification closed the review queue");
  assert.match(whyNot(a, "publish"), /not verified/i);
});

/* ================================================================ */
test("every one of the twelve states can actually be reached", () => {
  /*
   * THE BUG THIS TEST EXISTS FOR.
   *
   * `FINAL_APPROVED` was in the enum, in four `from:` arrays, in rights.js as
   * PUBLISHER.approveFinal and in whoCan() — and NO transition ever wrote it.
   * The state existed everywhere except in the one place that could produce
   * it. `EXPIRED` was the same: the public feed hid an out-of-window
   * promotion correctly, but the row still said PUBLISHED, so a customer's
   * dashboard and the homepage disagreed about whether their campaign was
   * running.
   *
   * A state in the enum that nothing can write is a state the product claims
   * to have and does not. Counting arrows is how that gets caught.
   */
  const reachable = new Set(["DRAFT"]);          // where every promotion starts
  for (const t of Object.values(TRANSITIONS)) {
    for (const from of t.from) reachable.add(t.to(from));
  }
  const declared = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED",
                    "RESUBMITTED", "MARKETING_APPROVED", "FINAL_APPROVED",
                    "SCHEDULED", "PUBLISHED", "PAUSED", "EXPIRED", "REJECTED"];
  const unreachable = declared.filter((s) => !reachable.has(s));
  assert.deepEqual(unreachable, [],
    `these states are declared but no transition writes them: ${unreachable.join(", ")}`);
  assert.equal(reachable.size, 12);
});

test("final approval is a separate judgement from marketing approval", () => {
  /* Marketing approving the COPY and a publisher clearing it to GO are
     different decisions by different people — which is the reason no role
     here is a superset of the one before it. */
  assert.ok(TRANSITIONS.approveFinal, "approveFinal transition is missing");
  assert.deepEqual(TRANSITIONS.approveFinal.from, ["MARKETING_APPROVED"]);
  assert.equal(TRANSITIONS.approveFinal.to("MARKETING_APPROVED"), "FINAL_APPROVED");
  assert.equal(TRANSITIONS.approveFinal.right, "approveFinal");

  /* And publishing straight from MARKETING_APPROVED stays allowed, because
     that is what the console does today and removing it would break a
     working queue. */
  assert.ok(TRANSITIONS.publish.from.includes("MARKETING_APPROVED"));
});

test("expiring is a publisher's act, and only from a live state", () => {
  assert.ok(TRANSITIONS.expire, "expire transition is missing");
  assert.equal(TRANSITIONS.expire.to("PUBLISHED"), "EXPIRED");
  assert.equal(TRANSITIONS.expire.right, "publish");
  /* Nothing in a draft or a review queue has a run to end. */
  for (const s of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED",
                   "RESUBMITTED", "REJECTED", "MARKETING_APPROVED", "FINAL_APPROVED"]) {
    assert.ok(!TRANSITIONS.expire.from.includes(s), `expire should not be reachable from ${s}`);
  }
});

test("EXPIRED is still not public, however it was reached", () => {
  /* The whole reason the state is safe to write: one state is public. */
  assert.equal(PUBLIC_STATES.has("EXPIRED"), false);
  assert.equal(PUBLIC_STATES.has("FINAL_APPROVED"), false);
  assert.equal(PUBLIC_STATES.size, 1);
});

test("there is no arrow from DRAFT to PUBLISHED", () => {
  assert.ok(!TRANSITIONS.publish.from.includes("DRAFT"),
    "a draft could be published in one step");
  assert.ok(!TRANSITIONS.publish.from.includes("SUBMITTED"));
  assert.ok(!TRANSITIONS.publish.from.includes("UNDER_REVIEW"));
  assert.ok(!TRANSITIONS.publish.from.includes("CHANGES_REQUESTED"));
  assert.ok(!TRANSITIONS.publish.from.includes("REJECTED"));
});

test("publishing is only possible from a state a reviewer put it in", () => {
  assert.deepEqual(TRANSITIONS.publish.from.sort(),
    ["FINAL_APPROVED", "MARKETING_APPROVED", "PAUSED", "SCHEDULED"]);
});

test("coming back after changes is a resubmission, not a new submission", () => {
  assert.equal(TRANSITIONS.submit.to("DRAFT"), "SUBMITTED");
  assert.equal(TRANSITIONS.submit.to("CHANGES_REQUESTED"), "RESUBMITTED");
  assert.equal(TRANSITIONS.submit.to("REJECTED"), "RESUBMITTED");
});

test("sending something back always demands a message", () => {
  assert.equal(TRANSITIONS.requestChanges.needsMessage, true);
  assert.equal(TRANSITIONS.reject.needsMessage, true);
  assert.equal(TRANSITIONS.pause.needsMessage, true);
  /* Approving does not: silence there means yes, and that is unambiguous. */
  assert.ok(!TRANSITIONS.approveMarketing.needsMessage);
  assert.ok(!TRANSITIONS.publish.needsMessage);
});

test("every transition names the right it needs", () => {
  for (const [name, t] of Object.entries(TRANSITIONS)) {
    assert.ok(t.right, `${name} has no right`);
    assert.ok(Array.isArray(t.from) && t.from.length, `${name} has no source states`);
    assert.equal(typeof t.to, "function", `${name} has no destination`);
    for (const s of t.from) {
      assert.ok(ALL_STATES.includes(s), `${name} lists an unknown state ${s}`);
    }
    assert.ok(ALL_STATES.includes(t.to(t.from[0])), `${name} produces an unknown state`);
  }
});

/* ================================================================ */
test("the content check catches what it says it catches", () => {
  const bad = {
    headline: "BEST PRICES GUARANTEED IN WESTLANDS!!",
    subtitle: "New apartments.",
    description: "New apartments now on PALTAS",
    type: "property", destination: "Westlands", placement: "discover", audience: "all",
    startDate: "2026-10-01", endDate: "",
    ctaLabel: "See them", ctaDestination: "", terms: "",
  };
  const r = contentCheck(bad);
  const st = (k: Wire) => (r.rows.find((x) => x.k === k) || {}).st;

  assert.equal(r.rows.length, 10, "there should be ten checks");
  assert.equal(st("Unsupported claims"), "ACTION", "“guaranteed” was not caught");
  assert.equal(st("Offer dates"), "ACTION", "a missing end date was not caught");
  assert.equal(st("Call to action"), "ACTION", "a button with nowhere to go was not caught");
  assert.equal(st("Grammar"), "REVIEW", "a headline in capitals was not flagged");
  assert.equal(r.ready, false, "a promotion with four blocking problems was ready to submit");
});

test("a complete promotion passes every check", () => {
  const good = {
    headline: "20% off your Makkah stay",
    subtitle: "For Hajj and Umrah guests.",
    description: "20% off selected rooms in Makkah for Hajj and Umrah guests.",
    type: "hajj_umrah", offer: "20%", destination: "Makkah",
    placement: "discover", audience: "travellers",
    startDate: "2026-09-01", endDate: "2026-12-20",
    ctaLabel: "Book your stay", ctaDestination: "index.html?go=stay",
    terms: "Applies to selected room types on direct bookings. Subject to availability.",
  };
  const r = contentCheck(good);
  assert.equal(r.worst, "PASS", JSON.stringify(r.rows.filter((x) => x.st !== "PASS")));
  assert.equal(r.ready, true);
});

test("the check never approves anything — PASS is the strongest thing it says", () => {
  const r = contentCheck({ headline: "h", description: "a".repeat(40) + ".", ctaLabel: "c",
    ctaDestination: "/", type: "t", destination: "d", placement: "p", audience: "a",
    startDate: "2026-01-01", endDate: "2026-02-01", terms: "Terms that are long enough." });
  for (const row of r.rows) {
    assert.ok(["PASS", "REVIEW", "ACTION"].includes(row.st));
    assert.notEqual(row.st, "APPROVED");
  }
});

test("the creative check reads properties, and fails what it should", () => {
  const small = creativeCheck({ name: "x.jpg", w: 1000, h: 1000, mb: 6.4, busy: true });
  const st = (r: Wire, k: Wire) => (r.rows.find((x: Wire) => x.k === k) || {}).st;
  assert.equal(st(small, "Resolution"), "ACTION");
  assert.equal(st(small, "Aspect ratio"), "ACTION", "a square image passed a 16:9 check");
  assert.equal(st(small, "File size"), "ACTION");
  assert.equal(st(small, "Text readability"), "REVIEW", "a busy image should be flagged, not failed");

  const good = creativeCheck({ name: "x.jpg", w: 1920, h: 1080, mb: 2.1, busy: false });
  assert.equal(good.ready, true);

  const none = creativeCheck(null);
  assert.equal(none.none, true, "no image should be its own state");
  assert.equal(none.ready, false, "no image should not be ready");
});

test("the creative rules are configurable in one place", () => {
  assert.equal(CREATIVE_RULES.minW, 1600);
  assert.equal(CREATIVE_RULES.maxMB, 5);
  assert.ok(CREATIVE_RULES.types.includes("webp"));
});

/* ================================================================ */
test("a request cannot set the fields that decide anything", () => {
  const data = cleanPromotionInput({
    headline: "Legitimate",
    status: "PUBLISHED",
    orgId: "somebody-elses-company",
    ref: "PR-0001",
    createdById: "another-user",
    id: "forged",
    reviewedBy: "PALTAS Publisher",
  });
  for (const forbiddenKey of ["status", "orgId", "ref", "createdById", "id", "reviewedBy"]) {
    assert.ok(!(forbiddenKey in data), `a request could set ${forbiddenKey}`);
  }
  assert.equal(data.headline, "Legitimate");
});

test("priority cannot be pushed above everything else", () => {
  assert.equal(cleanPromotionInput({ priority: 99999 }).priority, 100);
  assert.equal(cleanPromotionInput({ priority: -5 }).priority, 0);
  assert.equal(cleanPromotionInput({ priority: "60" }).priority, 60);
});

test("an end date before the start date is refused", () => {
  assert.throws(
    () => cleanPromotionInput({ startDate: "2026-10-01", endDate: "2026-09-01" }),
    /end date is before the start date/i);
});

test("an over-long headline is refused rather than silently cut", () => {
  assert.throws(() => cleanPromotionInput({ headline: "x".repeat(200) }), /longer than/i);
});

test("nonsense in a date field is refused", () => {
  assert.throws(() => cleanPromotionInput({ startDate: "next Thursday-ish" }), /not a date/i);
  /* An empty string is a real instruction — "clear this date" — and is kept. */
  assert.equal(cleanPromotionInput({ startDate: "" }).startDate, null);
});

/* ================================================================ */
test("the public wire carries nothing about the people involved", () => {
  const row = {
    ref: "PR-0001", org: { name: "A hotel" }, status: "PUBLISHED",
    headline: "h", ctaLabel: "c", ctaDestination: "/", priority: 50,
    createdBy: { name: "Wanjiru Kamau", email: "w@example.com" },
    reviewedBy: "Grace Wambui",
    events: [{ at: new Date(), byName: "Grace Wambui", what: "changes requested",
               why: "Remove the claim about being cheapest.", status: "CHANGES_REQUESTED" }],
    imageMeta: { name: "internal-file.jpg", w: 1, h: 1, mb: 1 },
  };
  const pub = toPublicWire(row);
  const text = JSON.stringify(pub);

  assert.ok(!("createdBy" in pub), "the public feed names the author");
  assert.ok(!("reviewedBy" in pub), "the public feed names the reviewer");
  assert.ok(!("reviewHistory" in pub), "the public feed carries the review history");
  assert.ok(!text.includes("Wanjiru"), "an author's name reached the public feed");
  assert.ok(!text.includes("Grace"), "a reviewer's name reached the public feed");
  assert.ok(!text.includes("cheapest"), "a reviewer's private message reached the public feed");
  assert.ok(!text.includes("internal-file"), "internal file metadata reached the public feed");
});

test("the private wire is the shape the frontend already reads", () => {
  const row = {
    id: "internal", ref: "PR-0007", orgId: "o1", org: { name: "A hotel" },
    title: "t", headline: "h", subtitle: "s", description: "d", type: "seasonal",
    offer: "20%", startDate: new Date("2026-10-01"), endDate: new Date("2026-11-01"),
    destination: "Nairobi", ctaLabel: "Book", ctaDestination: "/stay", terms: "T",
    image: "", imageMeta: null, placement: "discover", audience: "all", language: "en",
    priority: 60, status: "SUBMITTED", aiDrafted: true,
    createdBy: { name: "Wanjiru Kamau" }, reviewedBy: "",
    createdAt: new Date(), updatedAt: new Date(),
    events: [{ at: new Date(), byName: "Wanjiru Kamau", what: "created", why: "", status: "DRAFT" }],
  };
  const w = toWire(row);

  /* `id` is the REFERENCE, because that is what the frontend has always shown
     and what a customer quotes on the phone. */
  assert.equal(w.id, "PR-0007");
  assert.equal(w.startDate, "2026-10-01", "dates must be YYYY-MM-DD for a date input");
  assert.equal(w.endDate, "2026-11-01");
  assert.equal(w.createdBy, "Wanjiru Kamau");
  assert.ok(Array.isArray(w.reviewHistory));
  assert.deepEqual(Object.keys(w.reviewHistory[0]).sort(),
    ["at", "by", "status", "what", "why"]);
  for (const k of ["headline", "subtitle", "description", "offer", "destination",
                   "ctaLabel", "ctaDestination", "terms", "placement", "audience",
                   "language", "priority", "status", "aiDrafted", "organization"]) {
    assert.ok(k in w, `the wire is missing ${k}`);
  }
});
