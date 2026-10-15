// Super Admin managing one organisation: its details, plan, trial, terms, allowance, modules, and invoices.
// Every change needs the super_admin staff role, is audited, and never touches another product or organisation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("Super Admin: organisation management", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  let A: { orgId: string; admin: Person };
  let B: { orgId: string; admin: Person };
  const reason = "Ticket PAL-1042";

  beforeAll(async () => {
    S = await startServer();
    sa = await S.staff();
    A = await S.newOrg({ name: "Alpha Lettings", plan: "PM-STARTER", trial: true });
    B = await S.newOrg({ name: "Bravo Homes", plan: "PM-STARTER", trial: false });
  });
  afterAll(() => S.close());

  const detail = (orgId: string) => sa.api.admin.getOrganisation({ params: { orgId } });
  const sub = async (orgId: string, product = "property") =>
    (await detail(orgId)).subscriptions.find((s) => s.product === product)!;

  it("shows one organisation in full: members, terms and each subscription as the rules resolve it", async () => {
    const d = await detail(A.orgId);
    expect(d).toMatchObject({ id: A.orgId, name: "Alpha Lettings", terms: { discountPct: 0, note: "" } });
    expect(d.members.map((m) => [m.email, m.role, m.status])).toEqual([[A.admin.email, "org_admin", "active"]]);
    expect(d.subscriptions).toHaveLength(1);
    expect(d.subscriptions[0]).toMatchObject({ product: "property", plan: "PM-STARTER", status: "trial", addons: [] });
    expect(d.subscriptions[0]!.entitlement).toMatchObject({
      usable: true,
      plan: "PM-STARTER",
      modules: { maint: true },
    });
    await refused(detail("ORG-NOPE"), 404);
  });

  it("is staff only: a client administrator sees nothing", async () => {
    await refused(A.admin.api.admin.getOrganisation({ params: { orgId: A.orgId } }), 404);
    await refused(A.admin.api.admin.listInvoices(), 404);
    await refused(A.admin.api.admin.setTerms({ params: { orgId: A.orgId }, body: { discountPct: 50, note: "" } }), 404);
  });

  it("changes details and makes someone administrator (shown a temporary password once)", async () => {
    const r = await sa.api.admin.updateOrganisation({
      params: { orgId: A.orgId },
      body: {
        legalName: "Alpha Lettings Ltd",
        timezone: "Africa/Nairobi",
        admin: { email: "Ops@Alpha.test", name: "Ops" },
      },
    });
    expect(r.temporaryPassword).toHaveLength(20);
    const d = await detail(A.orgId);
    expect(d).toMatchObject({ legalName: "Alpha Lettings Ltd", timezone: "Africa/Nairobi" });
    expect(d.members.find((m) => m.email === "ops@alpha.test")).toMatchObject({ role: "org_admin", status: "active" });
    // the name of another organisation is taken
    await refused(sa.api.admin.updateOrganisation({ params: { orgId: A.orgId }, body: { name: "bravo homes" } }), 409);
    // staff never administer a client
    const staffEmail = (
      await S.sql<{ email: string }>("SELECT email FROM users WHERE staff_role IS NOT NULL LIMIT 1")
    )[0]!.email;
    await refused(
      sa.api.admin.updateOrganisation({ params: { orgId: A.orgId }, body: { admin: { email: staffEmail } } }),
      400,
    );
  });

  it("moves one subscription to another plan now, and drops a scheduled plan change", async () => {
    await S.sql(
      "INSERT INTO subscription_pending (id, org_id, product, type, plan_id, effective) VALUES ('PEND-T1', $1, 'property', 'plan', 'PM-STARTER', '2026-12-01')",
      [A.orgId],
    );
    expect(await sa.api.admin.setPlan({ params: { orgId: A.orgId }, body: { plan: "PM-GROWTH", reason } })).toEqual({
      ok: true,
      product: "property",
    });
    const s = await sub(A.orgId);
    expect(s.plan).toBe("PM-GROWTH");
    expect(s.pending).toEqual([]);
    expect(s.entitlement.modules.crm).toBe(true); // Growth includes CRM
    await refused(sa.api.admin.setPlan({ params: { orgId: A.orgId }, body: { plan: "PM-GROWTH", reason } }), 400);
    // a Development plan on an organisation without Development
    await refused(sa.api.admin.setPlan({ params: { orgId: A.orgId }, body: { plan: "DEV-STD", reason } }), 404);
    await refused(sa.api.admin.setPlan({ params: { orgId: A.orgId }, body: { plan: "PM-GROWTH", reason: "x" } }), 400);
  });

  it("sets a trial end date only on a subscription that is on trial", async () => {
    await sa.api.admin.setTrial({ params: { orgId: A.orgId }, body: { trialEnds: "2026-12-31", reason } });
    expect((await sub(A.orgId)).trialEnds).toBe("2026-12-31");
    await refused(
      sa.api.admin.setTrial({ params: { orgId: B.orgId }, body: { trialEnds: "2026-12-31", reason } }),
      400,
    );
  });

  it("negotiated terms, and the building allowance of one subscription", async () => {
    await sa.api.admin.setTerms({ params: { orgId: B.orgId }, body: { discountPct: 12.5, note: "Pilot agreement" } });
    expect((await detail(B.orgId)).terms).toEqual({ discountPct: 12.5, note: "Pilot agreement" });
    await sa.api.admin.setAllowance({ params: { orgId: B.orgId }, body: { extra: 2, override: 3, reason } });
    const s = await sub(B.orgId);
    expect(s.buildings).toEqual({ extra: 2, override: 3 });
    expect(s.entitlement.allowance).toMatchObject({ included: 3, extra: 2, allowed: 5 });
    await refused(
      sa.api.admin.setAllowance({ params: { orgId: B.orgId }, body: { extra: 501, override: null, reason } }),
      400,
    );
  });

  it("switches a module on or off for one subscription, checking what depends on what", async () => {
    // payments needs finance; Starter has finance, not payments
    const on = await sa.api.admin.setModule({
      params: { orgId: B.orgId, moduleKey: "payments" },
      body: { on: true, reason },
    });
    expect(on.modules.payments).toBe(true);
    expect((await sub(B.orgId)).addons).toContain("payments");
    // finance cannot go while payments depends on it
    const r = await refused(
      sa.api.admin.setModule({ params: { orgId: B.orgId, moduleKey: "finance" }, body: { on: false, reason } }),
      400,
    );
    expect(r.message).toMatch(/depend/);
    await sa.api.admin.setModule({ params: { orgId: B.orgId, moduleKey: "payments" }, body: { on: false, reason } });
    const off = await sa.api.admin.setModule({
      params: { orgId: B.orgId, moduleKey: "finance" },
      body: { on: false, reason },
    });
    expect(off.modules.finance).toBe(false);
    const s = await sub(B.orgId);
    expect(s.disabled).toEqual(expect.arrayContaining(["finance", "payments"]));
    expect(s.addons).not.toContain("payments");
    // and back on: a plan module is re-enabled, not bought as an add-on
    await sa.api.admin.setModule({ params: { orgId: B.orgId, moduleKey: "finance" }, body: { on: true, reason } });
    expect((await sub(B.orgId)).addons).not.toContain("finance");
    await refused(
      sa.api.admin.setModule({ params: { orgId: B.orgId, moduleKey: "nope" }, body: { on: true, reason } }),
      404,
    );
    // the other organisation is untouched
    expect((await sub(A.orgId)).disabled).toEqual([]);
  });

  it("lists invoices across organisations and voids an unpaid one; a paid one stays", async () => {
    const i1 = await sa.api.admin.issueInvoice({ params: { orgId: B.orgId }, body: {} });
    const all = await sa.api.admin.listInvoices();
    expect(all.invoices.find((i) => i.id === i1.id)).toMatchObject({
      orgId: B.orgId,
      orgName: "Bravo Homes",
      status: "Open",
    });
    expect((await sa.api.admin.listInvoices({ query: { orgId: A.orgId } })).invoices).toEqual([]);
    expect(await sa.api.admin.voidInvoice({ params: { invoiceId: i1.id }, body: { reason } })).toEqual({ ok: true });
    expect((await sa.api.admin.listInvoices({ query: { status: "Void" } })).invoices.map((i) => i.id)).toContain(i1.id);
    await refused(sa.api.admin.voidInvoice({ params: { invoiceId: i1.id }, body: { reason } }), 409);
    // a new invoice for the same period may be issued once the old one is void; when paid it cannot be voided
    const i2 = await sa.api.admin.issueInvoice({ params: { orgId: B.orgId }, body: {} });
    await sa.api.admin.recordReceipt({ params: { invoiceId: i2.id }, body: { ref: "BANK-T-0001", reason } });
    const r = await refused(sa.api.admin.voidInvoice({ params: { invoiceId: i2.id }, body: { reason } }), 409);
    expect(r.message).toMatch(/paid/);
    await refused(sa.api.admin.voidInvoice({ params: { invoiceId: "SUB-NOPE" }, body: { reason } }), 404);
  });

  it("every change is in the audit trail, with the reason", async () => {
    const actions = (await sa.api.admin.audit({ query: { orgId: B.orgId, limit: 100 } })).entries.map((e) => e.action);
    for (const a of [
      "Negotiated terms changed",
      "Building allowance changed",
      "Module enabled",
      "Module disabled",
      "Subscription invoice voided",
    ])
      expect(actions).toContain(a);
    const plan = (await sa.api.admin.audit({ query: { orgId: A.orgId, limit: 100 } })).entries.find(
      (e) => e.action === "Plan changed",
    );
    expect(plan).toMatchObject({ detail: reason, before: { plan: "PM-STARTER" }, after: { plan: "PM-GROWTH" } });
  });
});
