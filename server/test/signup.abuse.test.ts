// Abuse and enumeration: the public sign-up answers the same way whatever exists, never creates PALTAS staff,
// validates against the catalogue and the current terms, is limited per address and per e-mail, and lets one
// business have one trial per policy window (PALTAS staff may override with a reason, or decline).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNUP_RECEIVED } from "../dist/core/signup/signup.service.js";
import { staffMember } from "./support/platform-fixtures.js";
import { postSignup, signupBody, signUpAndIn, signupServer, uniquePhone } from "./support/signup-fixture.js";
import { refused, TODAY, type TestServer } from "./support/test-server.js";

describe("sign-up abuse and enumeration", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  const signups = (email: string) =>
    S.sql<{ status: string; matched: { by: string }[]; password_hash: string | null; org_id: string | null }>(
      "SELECT status, matched, password_hash, org_id FROM org_signups WHERE email = lower($1) ORDER BY created_at, id",
      [email],
    );

  beforeAll(async () => {
    S = await signupServer();
    sa = await S.staff();
  });
  afterAll(() => S.close());

  it("answers exactly the same for a new business, a known e-mail, a taken name, a repeat and a staff address", async () => {
    const first = signupBody("property", { company: "Kilima Homes Ltd" });
    const answers = [await postSignup(S, first)];
    // the same e-mail (other case), a taken organisation name, the same business again (phone), a staff address
    answers.push(await postSignup(S, signupBody("hotel", { email: first.email.toUpperCase() })));
    answers.push(await postSignup(S, signupBody("security", { company: "KILIMA HOMES LTD" })));
    answers.push(await postSignup(S, signupBody("agency", { phone: first.phone })));
    const staff = await staffMember(S);
    const [staffBefore] = await S.sql("SELECT password_hash, staff_role FROM users WHERE id = $1", [staff.userId]);
    answers.push(
      await postSignup(S, {
        ...signupBody("developer", { email: staff.email }),
        staffRole: "super_admin",
        staff: true,
      }),
    );
    for (const a of answers) expect(a).toEqual({ status: 201, body: SIGNUP_RECEIVED });
    // what really happened is only for PALTAS
    expect((await signups(first.email)).map((s) => s.status)).toEqual(["created", "duplicate"]);
    const all = await S.sql<{ status: string; by: string }>(
      "SELECT status, matched->0->>'by' AS by FROM org_signups ORDER BY created_at, id",
    );
    expect(all).toEqual([
      { status: "created", by: null },
      { status: "duplicate", by: "account" },
      { status: "duplicate", by: "name" },
      { status: "blocked_repeat", by: "phone" },
      { status: "duplicate", by: "account" },
    ]);
    // the staff account is untouched: same password, still staff, never a member of anything
    expect(await S.sql("SELECT password_hash, staff_role FROM users WHERE id = $1", [staff.userId])).toEqual([
      staffBefore,
    ]);
    expect(await S.sql("SELECT 1 FROM memberships WHERE user_id = $1", [staff.userId])).toEqual([]);
    expect(
      await S.sql("SELECT 1 FROM users WHERE staff_role IS NOT NULL AND id NOT IN ($1, $2)", [staff.userId, sa.userId]),
    ).toEqual([]);
  });

  it("never creates staff: the administrator is a plain client account with the password they chose", async () => {
    const body = { ...signupBody("hotel"), staffRole: "super_admin", role: "super_admin" };
    expect((await postSignup(S, body)).status).toBe(201);
    const [u] = await S.sql<{ staff_role: string | null; must_change_password: boolean; role: string }>(
      `SELECT u.staff_role, u.must_change_password, m.role FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE u.email = lower($1)`,
      [body.email],
    );
    expect(u).toEqual({ staff_role: null, must_change_password: false, role: "org_admin" });
    const s = await S.login(body.email, body.password);
    expect(await S.raw("GET", "/api/v1/admin/orgs", undefined, s.token)).toMatchObject({ status: 404 });
    const [o] = await S.sql<{ demo: boolean }>(
      "SELECT o.demo FROM organisations o JOIN memberships m ON m.org_id = o.id JOIN users u ON u.id = m.user_id WHERE u.email = lower($1)",
      [body.email],
    );
    expect(o!.demo).toBe(false);
  });

  it("validates against the catalogue, the current terms and the core password rules", async () => {
    const bad = async (o: Record<string, unknown>, status = 400) =>
      expect((await postSignup(S, { ...signupBody("property"), ...o })).status).toBe(status);
    await bad({ terms: { accepted: true, version: "1999-01" } });
    await bad({ terms: { accepted: false, version: "2026-10" } });
    await bad({ plan: "PM-ENTERPRISE" }); // agreed with PALTAS, not self-service
    await bad({ plan: "HOTEL-STD" }); // a plan of another product
    await bad({ plan: "NO-SUCH-PLAN" });
    await bad({ password: "short" });
    await bad({ phone: "0700 000 000" });
    await bad({ timezone: "Mars/Olympus" });
    await bad({ email: "not-an-email" });
    expect(
      await S.sql("SELECT 1 FROM org_signups WHERE plan_id IN ('PM-ENTERPRISE', 'HOTEL-STD') AND product = 'property'"),
    ).toEqual([]);
  });

  it("is switched off unless SIGNUP_ENABLED", async () => {
    const off = await signupServer({ enabled: false });
    try {
      const r = await postSignup(off, signupBody("property"));
      expect([r.status, r.body.error.code]).toEqual([403, "FORBIDDEN"]);
      expect(await off.sql("SELECT 1 FROM organisations")).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it("is limited per address per hour and per e-mail per day", async () => {
    const L = await signupServer({ perIpPerHour: 4, perEmailPerDay: 2 });
    try {
      const a = signupBody("property");
      expect((await postSignup(L, a)).status).toBe(201);
      expect((await postSignup(L, { ...a, company: "Other name one" })).status).toBe(201); // a duplicate, counted
      const e = await postSignup(L, { ...a, company: "Other name two" });
      expect([e.status, e.body.error.code]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
      expect((await postSignup(L, signupBody("hotel"))).status).toBe(201);
      expect((await postSignup(L, signupBody("security"))).status).toBe(201);
      const ip = await postSignup(L, signupBody("agency"));
      expect([ip.status, ip.body.error.code]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
      expect((await L.sql("SELECT 1 FROM org_signups")).length).toBe(4);
    } finally {
      await L.close();
    }
  });

  it("one trial per business: same phone, or same company name and country, inside the window is held", async () => {
    const orig = await signUpAndIn(S, "developer", { company: "Mto Developers Limited", country: "Kenya" });
    const [origPhone] = await S.sql<{ phone: string }>("SELECT phone FROM org_signups WHERE org_id = $1", [orig.orgId]);
    const sameCompany = signupBody("hotel", { company: "the MTO developers ltd.", country: "kenya" });
    const samePhone = signupBody("agency", { phone: origPhone!.phone.replace(/^(\+254)(\d{3})/, "$1 $2 ") });
    const otherCountry = signupBody("hotel", { company: "Mto Developers", country: "Uganda" });
    for (const b of [sameCompany, samePhone, otherCountry]) expect((await postSignup(S, b)).status).toBe(201);
    expect((await signups(sameCompany.email)).map((s) => [s.status, s.matched.map((m) => m.by)])).toEqual([
      ["blocked_repeat", ["company"]],
    ]);
    expect((await signups(samePhone.email)).map((s) => [s.status, s.matched.map((m) => m.by)])).toEqual([
      ["blocked_repeat", ["phone"]],
    ]);
    expect((await signups(otherCountry.email))[0]!.status).toBe("created");
    // a held request created nothing: the person cannot sign in
    await refused(S.login(sameCompany.email, sameCompany.password), 401);
    // outside the window the same phone may start a trial again
    S.setToday(entitlementsDay(400));
    const later = signupBody("security", { phone: origPhone!.phone });
    expect((await postSignup(S, later)).status).toBe(201);
    expect((await signups(later.email))[0]!.status).toBe("created");
    S.setToday(TODAY);

    // PALTAS staff decide: allow one (with a reason), decline the other
    const held = (await sa.api.admin.listSignups({ query: { status: "blocked_repeat" } })).signups;
    const toAllow = held.find((h) => h.email === sameCompany.email)!;
    const toDecline = held.find((h) => h.email === samePhone.email)!;
    expect(toAllow.matched).toEqual([{ by: "company", orgId: orig.orgId }]);
    const support = await staffMember(S, "support");
    await refused(
      support.api.admin.allowSignup({ params: { signupId: toAllow.id }, body: { reason: "Support cannot" } }),
      403,
    );
    await refused(sa.api.admin.allowSignup({ params: { signupId: toAllow.id }, body: { reason: "no" } }), 400);
    const allowed = await sa.api.admin.allowSignup({
      params: { signupId: toAllow.id },
      body: { reason: "New hotel subsidiary of the developer — confirmed by phone" },
    });
    expect([allowed.status, allowed.decidedBy, !!allowed.orgId]).toEqual(["allowed", sa.userId, true]);
    const s = await S.login(sameCompany.email, sameCompany.password); // the password they chose at sign-up
    const ent = await s.api.subscriptions.entitlements({ params: { orgId: allowed.orgId! }, query: {} });
    expect([ent.product, ent.status, ent.trial?.daysLeft]).toEqual(["hotel", "trial", 30]);
    const [reg] = await S.sql<{ override_reason: string; override_by: string }>(
      "SELECT override_reason, override_by FROM trial_registry WHERE org_id = $1",
      [allowed.orgId],
    );
    expect(reg).toEqual({
      override_reason: "New hotel subsidiary of the developer — confirmed by phone",
      override_by: sa.userId,
    });
    const declined = await sa.api.admin.declineSignup({
      params: { signupId: toDecline.id },
      body: { reason: "Same owner as an earlier trial" },
    });
    expect(declined.status).toBe("declined");
    await refused(
      sa.api.admin.allowSignup({ params: { signupId: toDecline.id }, body: { reason: "Changed my mind" } }),
      409,
    );
    // the chosen password of a held request is kept only until the decision
    expect((await signups(sameCompany.email))[0]!.password_hash).toBeNull();
    expect((await signups(samePhone.email))[0]!.password_hash).toBeNull();
    const actions = (await sa.api.admin.audit({ query: { limit: 50 } })).entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["Repeat trial allowed by PALTAS", "Repeat trial declined by PALTAS"]),
    );
  });

  it("staff onboarding applies the same one-trial rule, with an override reason kept", async () => {
    const body = {
      name: "Pwani Guards Ltd",
      product: "security" as const,
      plan: "SEC-STD",
      country: "Kenya",
      currency: "KES",
      timezone: "Africa/Nairobi",
      trial: true,
      admin: { email: "ops@pwani-guards.test" },
    };
    await sa.api.admin.createOrganisation({ body });
    const again = { ...body, name: "Pwani Guards Limited", admin: { email: "new-ops@pwani-guards.test" } };
    const r = await refused(sa.api.admin.createOrganisation({ body: again }), 409);
    expect(r.details.repeatTrial).toBe(true);
    const ok = await sa.api.admin.createOrganisation({
      body: { ...again, repeatTrialReason: "Group restructuring — new company" },
    });
    expect(ok.id).toMatch(/^ORG-/);
    // the same business signing itself up is held for review, not given a second trial
    const self = signupBody("security", { company: "Pwani Guards" });
    expect((await postSignup(S, self)).status).toBe(201);
    expect((await signups(self.email))[0]!.status).toBe("blocked_repeat");
    // the same administrator e-mail behind a differently named business is a repeat too
    const byEmail = await refused(
      sa.api.admin.createOrganisation({
        body: { ...body, name: "Coastline Patrols", admin: { email: "OPS@pwani-guards.test" } },
      }),
      409,
    );
    expect(byEmail.details.matched.map((m: { by: string }) => m.by)).toEqual(["email"]);
    // a trial-less onboarding is never blocked
    await sa.api.admin.createOrganisation({
      body: { ...body, name: "Coastline Patrols", trial: false, admin: { email: "ops@pwani-guards.test" } },
    });
  });

  it("a fresh phone number is needed per business (the phone is normalised before the check)", async () => {
    const p = uniquePhone();
    const one = signupBody("property", { phone: p });
    const two = signupBody("property", { phone: p.replace(/^\+2547/, "+254 7").replace(/(\d{3})$/, "-$1") });
    await postSignup(S, one);
    await postSignup(S, two);
    expect((await signups(two.email))[0]!.status).toBe("blocked_repeat");
  });
});

function entitlementsDay(n: number) {
  const d = new Date(TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
