// The Super Admin console:
// - the PALTAS team: a Super Admin invites staff with a role (credentials shown once, two-factor at every sign-in),
//   changes roles, deactivates (sessions end at once) and resets sign-in; nobody changes their own account and the
//   last active Super Admin cannot be removed; client accounts never become staff;
// - each staff role may change only its own area (everyone may read);
// - the client directory (search, filters, how each company registered), people search and the platform overview.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totp } from "../dist/core/identity/totp.js";
import { staffMember } from "./support/platform-fixtures.js";
import { signupBody, signupServer } from "./support/signup-fixture.js";
import { refused, startServer, type TestServer } from "./support/test-server.js";

const WHY = "Joined the operations team";

describe("the PALTAS team", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  beforeAll(async () => {
    S = await startServer();
    sa = await S.staff();
  });
  afterAll(() => S.close());

  it("a Super Admin invites a colleague with a role; the colleague signs in with the code and changes the password", async () => {
    const c = await sa.api.admin.inviteStaff({
      body: { email: "Amina.Ops@paltas.test", name: "Amina Ops", role: "operations", reason: WHY },
    });
    expect(c.email).toBe("amina.ops@paltas.test");
    expect(c.otpauthUrl).toContain("otpauth://totp/");
    // the secret is stored sealed, the password only as a hash
    const [row] = await S.sql("SELECT password_hash, mfa_secret_sealed, staff_role FROM users WHERE id = $1", [
      c.userId,
    ]);
    expect(row.staff_role).toBe("operations");
    expect(row.password_hash).not.toContain(c.temporaryPassword);
    expect(row.mfa_secret_sealed).not.toContain(c.authenticatorSecret);
    // without the code: refused
    await refused(S.login(c.email, c.temporaryPassword), 401);
    const s = await S.login(c.email, c.temporaryPassword, totp(c.authenticatorSecret));
    const me = await s.api.identity.me();
    expect(me.user.staffRole).toBe("operations");
    expect(me.user.mustChangePassword).toBe(true);
    expect(me.user.staffPermissions).toEqual(["clients.manage", "marketplace.moderate", "platform.operate"]);
    const team = await sa.api.admin.listStaff();
    const amina = team.staff.find((m) => m.email === c.email)!;
    expect(amina).toMatchObject({ role: "operations", active: true, mustChangePassword: true });
    expect(amina.lastSignInAt).not.toBeNull();
    expect(team.roles.map((r) => r.role)).toEqual([
      "super_admin",
      "operations",
      "finance",
      "moderator",
      "marketing",
      "support",
    ]);
    const audit = await S.sql(
      "SELECT detail FROM audit_log WHERE action = 'PALTAS staff member added' AND target = $1",
      [c.email],
    );
    expect(audit[0].detail).toContain(WHY);
  });

  it("a client account never becomes staff, and only a Super Admin manages the team", async () => {
    const { admin } = await S.newOrg({ name: "Client Homes" });
    await refused(
      sa.api.admin.inviteStaff({ body: { email: admin.email, name: "Client", role: "support", reason: WHY } }),
      409,
    );
    const ops = await staffMember(S, "operations");
    await refused(
      ops.api.admin.inviteStaff({ body: { email: "x@paltas.test", name: "X Person", role: "support", reason: WHY } }),
      403,
      "STAFF_ROLE_NOT_ALLOWED",
    );
    await ops.api.admin.listStaff(); // reading is fine
    await refused(admin.api.admin.listStaff(), 404); // clients do not even see the endpoint
  });

  it("role changes and deactivation end the person's sessions at once; reactivation and a reset give new access", async () => {
    const m = await staffMember(S, "finance");
    await m.api.admin.listClients();
    await sa.api.admin.updateStaff({
      params: { userId: m.userId },
      body: { role: "support", reason: "Moved to support" },
    });
    await refused(m.api.admin.listClients(), 401); // the old session is gone
    await sa.api.admin.updateStaff({ params: { userId: m.userId }, body: { active: false, reason: "Left PALTAS" } });
    await refused(sa.api.admin.resetStaffAccess({ params: { userId: m.userId }, body: { reason: "Lost phone" } }), 409);
    await sa.api.admin.updateStaff({ params: { userId: m.userId }, body: { active: true, reason: "Came back" } });
    const c = await sa.api.admin.resetStaffAccess({ params: { userId: m.userId }, body: { reason: "Lost phone" } });
    const s = await S.login(m.email, c.temporaryPassword, totp(c.authenticatorSecret));
    expect((await s.api.identity.me()).user).toMatchObject({ staffRole: "support", mustChangePassword: true });
    await refused(
      sa.api.admin.updateStaff({ params: { userId: m.userId }, body: { role: "support", reason: "Same again" } }),
      400,
    );
  });

  it("nobody changes their own account; Super Admins change each other; the database accepts only known roles", async () => {
    await refused(
      sa.api.admin.updateStaff({ params: { userId: sa.userId }, body: { role: "support", reason: "Self demote" } }),
      400,
    );
    await refused(
      sa.api.admin.resetStaffAccess({ params: { userId: sa.userId }, body: { reason: "Self reset" } }),
      400,
    );
    const other = await staffMember(S, "super_admin");
    await other.api.admin.updateStaff({ params: { userId: sa.userId }, body: { role: "finance", reason: "Testing" } });
    await refused(sa.api.admin.listStaff(), 401); // demoted: signed out
    await other.api.admin.updateStaff({
      params: { userId: sa.userId },
      body: { role: "super_admin", reason: "Restore" },
    });
    sa = await S.staff();
    await expect(S.sql("UPDATE users SET staff_role = 'owner' WHERE id = $1", [sa.userId])).rejects.toThrow(/check/);
  });
});

describe("what each staff role may change", () => {
  let S: TestServer;
  let orgId: string;
  beforeAll(async () => {
    S = await startServer();
    orgId = (await S.newOrg({ name: "Role Test Estates" })).orgId;
  });
  afterAll(() => S.close());

  const terms = (api: any) =>
    api.admin.setTerms({ params: { orgId }, body: { discountPct: 5, note: "Launch partner" } });
  const suspend = (api: any) => api.ops.suspendOrg({ params: { orgId }, body: { reason: "Unpaid for three months" } });
  const reactivate = (api: any) => api.ops.reactivateOrg({ params: { orgId }, body: { reason: "Paid in full today" } });

  it("finance changes billing, not client accounts", async () => {
    const f = await staffMember(S, "finance");
    await terms(f.api);
    await refused(suspend(f.api), 403, "STAFF_ROLE_NOT_ALLOWED");
  });

  it("operations runs client accounts, not billing", async () => {
    const o = await staffMember(S, "operations");
    await suspend(o.api);
    await reactivate(o.api);
    await refused(terms(o.api), 403, "STAFF_ROLE_NOT_ALLOWED");
  });

  it("support and marketing only read here; data exports stay with Super Admin", async () => {
    for (const role of ["support", "marketing", "moderator"] as const) {
      const s = await staffMember(S, role);
      await refused(terms(s.api), 403, "STAFF_ROLE_NOT_ALLOWED");
      await refused(suspend(s.api), 403, "STAFF_ROLE_NOT_ALLOWED");
      expect((await s.api.admin.listClients()).total).toBeGreaterThan(0);
      expect((await s.api.identity.me()).user.staffPermissions).toEqual(
        role === "marketing" ? ["marketing.manage"] : role === "moderator" ? ["marketplace.moderate"] : [],
      );
    }
    const o = await staffMember(S, "operations");
    await refused(o.api.ops.exportOrg({ params: { orgId }, query: { reason: "Client asked for it" } }), 403);
  });
});

describe("client directory, people and overview", () => {
  let S: TestServer;
  let staff: Awaited<ReturnType<TestServer["staff"]>>;
  let kenya: string;
  let uk: string;
  beforeAll(async () => {
    S = await signupServer();
    staff = await S.staff();
    kenya = (await S.newOrg({ name: "Nairobi Keys", product: "agency", plan: "AGENCY-STD" })).orgId;
    uk = (await S.newOrg({ name: "London Lets", product: "property", currency: "GBP" })).orgId;
    await S.sql("UPDATE organisations SET country = 'United Kingdom' WHERE id = $1", [uk]);
    // a self-service sign-up
    const r = await S.raw(
      "POST",
      "/api/v1/public/signup",
      signupBody("agency", { company: "Mombasa Stays", adminName: "Halima Owner", email: "halima@mombasa.test" }),
    );
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  });
  afterAll(() => S.close());

  it("lists every company with how it registered, its administrator and products; search and filters narrow it", async () => {
    const all = await staff.api.admin.listClients();
    expect(all.total).toBe(3);
    const self = all.clients.find((c) => c.name === "Mombasa Stays")!;
    expect(self).toMatchObject({ source: "self_signup", country: "Kenya" });
    expect(self.admin).toMatchObject({ email: "halima@mombasa.test", emailVerified: false });
    expect(self.products[0]).toMatchObject({ product: "agency", status: "trial" });
    expect(all.clients.find((c) => c.id === kenya)!.source).toBe("paltas_staff");
    expect(all.countries).toEqual(expect.arrayContaining(["Kenya", "United Kingdom"]));

    expect((await staff.api.admin.listClients({ query: { q: "LONDON" } })).clients.map((c) => c.id)).toEqual([uk]);
    expect((await staff.api.admin.listClients({ query: { q: "halima@" } })).clients[0]!.name).toBe("Mombasa Stays");
    expect((await staff.api.admin.listClients({ query: { q: "100%_" } })).total).toBe(0); // wildcards are literal
    expect((await staff.api.admin.listClients({ query: { product: "property" } })).clients.map((c) => c.id)).toEqual([
      uk,
    ]);
    expect((await staff.api.admin.listClients({ query: { country: "united kingdom" } })).total).toBe(1);
    expect((await staff.api.admin.listClients({ query: { source: "self_signup" } })).total).toBe(1);
    const page = await staff.api.admin.listClients({ query: { sort: "name", limit: 2, offset: 2 } });
    expect(page.total).toBe(3);
    expect(page.clients.map((c) => c.name)).toEqual(["Nairobi Keys"]);

    await staff.api.ops.suspendOrg({ params: { orgId: uk }, body: { reason: "Unpaid for three months" } });
    const suspended = await staff.api.admin.listClients({ query: { status: "suspended" } });
    expect(suspended.clients.map((c) => c.id)).toEqual([uk]);
    expect(suspended.clients[0]!.suspended!.reason).toBe("Unpaid for three months");
    expect((await staff.api.admin.listClients({ query: { status: "trial" } })).clients.map((c) => c.id)).not.toContain(
      uk,
    );
  });

  it("finds a client account by e-mail with every company it belongs to; staff are not listed", async () => {
    const r = await staff.api.admin.searchPeople({ query: { q: "halima" } });
    expect(r.people).toHaveLength(1);
    expect(r.people[0]!.memberships[0]).toMatchObject({ orgName: "Mombasa Stays", role: "org_admin" });
    expect(
      (await staff.api.admin.searchPeople({ query: { q: "paltas.test" } })).people.every((p) => !/^sa\+/.test(p.email)),
    ).toBe(true);
  });

  it("the overview counts what is really there", async () => {
    const o = await staff.api.admin.overview();
    expect(o.clients).toMatchObject({ total: 3, newLast30Days: 3, suspended: 1 });
    expect(o.clients.bySource).toMatchObject({ self_signup: 1, paltas_staff: 2, business_request: 0, demo: 0 });
    expect(o.clients.subscriptions.reduce((n, s) => n + s.count, 0)).toBe(3);
    expect(o.people.staff).toBeGreaterThanOrEqual(1);
    expect(o.people.clientAccounts).toBe(3);
    expect(o.queues).toMatchObject({ signups: 0, businessRequests: 0, listings: 0, reviews: 0, priceChanges: 0 });
    expect(o.marketplace).toMatchObject({ liveListings: 0, bookingsLast30Days: 0, offersLast30Days: 0 });
  });
});
