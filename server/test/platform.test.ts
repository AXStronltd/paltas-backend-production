// Plans, modules, allowance, billing events, isolation, roles and keeping data — carried over from the earlier
// JavaScript starter's acceptance tests, now against PostgreSQL and through the typed client.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProducts } from "./support/fake-products.js";
import { refused, startServer, TODAY, type Person, type TestServer } from "./support/test-server.js";

describe("PALTAS platform: entitlements, billing, isolation", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  let A: { orgId: string; admin: Person; crmInvoice?: string };
  let B: { orgId: string; admin: Person };
  let C: { orgId: string; admin: Person };
  const fakes = fakeProducts();
  const post = (o: { orgId: string; admin: Person }, path: string, body: unknown) =>
    S.raw("POST", `/api/v1/orgs/${o.orgId}${path}`, body, o.admin.token);
  const get = (o: { orgId: string; admin: Person }, path: string, token = o.admin.token) =>
    S.raw("GET", `/api/v1/orgs/${o.orgId}${path}`, undefined, token);
  const pay = (id: string, invoice: { id: string; totalMinor: number }, ref: string) =>
    S.webhook({
      id,
      type: "subscription.payment",
      invoiceId: invoice.id,
      status: "succeeded",
      amountMinor: invoice.totalMinor,
      currency: "KES",
      ref,
    });

  beforeAll(async () => {
    S = await startServer({ products: fakes.modules });
    sa = await S.staff();
  });
  afterAll(() => S.close());

  it("health, and staff sign-in needs the second factor", async () => {
    expect((await S.api.identity.health()).ok).toBe(true);
    await refused(S.api.identity.me(), 401);
    expect((await sa.api.identity.me()).user.staffRole).toBe("super_admin");
  });

  it("Super Admin creates organisations; a client administrator is never staff", async () => {
    A = await S.newOrg({ name: "Alpha Lettings", plan: "PM-STARTER", trial: false });
    B = await S.newOrg({ name: "Bravo Property", plan: "PM-GROWTH", trial: false });
    C = await S.newOrg({ name: "Charlie Developments", product: "developer", plan: "DEV-STD", trial: false });
    await refused(
      sa.api.admin.createOrganisation({
        body: {
          name: "Wrong Plan Co",
          product: "developer",
          plan: "PM-STARTER",
          country: "Kenya",
          currency: "KES",
          timezone: "UTC",
          trial: false,
          admin: { email: "x@y.test" },
        },
      }),
      400,
    );
    await refused(
      sa.api.admin.createOrganisation({
        body: {
          name: "alpha lettings",
          product: "property",
          plan: "PM-STARTER",
          country: "Kenya",
          currency: "KES",
          timezone: "UTC",
          trial: false,
          admin: { email: "dup@y.test" },
        },
      }),
      409,
    );
    await refused(A.admin.api.admin.catalogue(), 404);
    expect((await A.admin.api.identity.me()).user.staff).toBe(false);
    // every new organisation starts with the core chart of accounts plus its product's accounts
    const chart = await A.admin.api.ledger.listAccounts({ params: { orgId: A.orgId } });
    expect(chart.accounts.map((a) => a.code)).toEqual(
      expect.arrayContaining(["1000", "1100", "2000", "3000", "4000", "1010"]),
    );
  });

  it("Standard, Pro and Enterprise entitlements", async () => {
    const a = await A.admin.api.subscriptions.entitlements({ params: { orgId: A.orgId } });
    expect([a.tier, a.modules.finance, a.modules.crm, a.modules.intelligence, a.essentials.length]).toEqual([
      "Standard",
      true,
      false,
      false,
      5,
    ]);
    const b = await B.admin.api.subscriptions.entitlements({ params: { orgId: B.orgId } });
    expect([b.tier, b.modules.crm, b.modules.intelligence, b.modules.automation]).toEqual(["Pro", true, true, false]);
    const ent = await refused(
      B.admin.api.subscriptions.changePlan({
        params: { orgId: B.orgId },
        body: { plan: "PM-ENTERPRISE", confirm: "CONFIRM" },
      }),
      400,
    );
    expect(ent.details.contactSales).toBe(true);
    expect(
      (
        await B.admin.api.subscriptions.enterpriseEnquiry({
          params: { orgId: B.orgId },
          body: { note: "40 buildings in two countries" },
        })
      ).status,
    ).toBe("New");
  });

  it("a feature outside the plan is refused even when called directly; reading is never blocked", async () => {
    const lead = await post(A, "/test-property/leads", { name: "Grace" });
    expect(lead.status).toBe(403);
    expect(lead.body.error.code).toBe("MODULE_NOT_ENTITLED");
    // the module is named in words, never by its internal key
    expect(lead.body.error.message).toBe(
      "Advanced CRM and Marketing is not in your plan. Existing records stay readable.",
    );
    expect(lead.body.error.details.canBuy).toBe(true);
    expect((await get(A, "/test-property/leads")).status).toBe(200);
  });

  it("buying a module waits for a verified payment; forged, stale, failed, short and replayed events change nothing", async () => {
    const r = await A.admin.api.subscriptions.buyAddon({
      params: { orgId: A.orgId },
      body: { module: "crm", confirm: "CONFIRM" },
    });
    expect(r.purchase.status).toMatch(/Awaiting payment/);
    const inv = r.invoice!;
    A.crmInvoice = inv.id;
    expect(inv.totalMinor).toBe(580_000); // KES 5,000 + 16% tax
    expect((await post(A, "/test-property/leads", { name: "Grace" })).status).toBe(403);
    expect(
      (await S.raw("POST", `/api/v1/orgs/${A.orgId}/subscription/addons`, { module: "crm" }, A.admin.token)).status,
    ).toBe(400);

    const ev = {
      id: "ev1",
      type: "subscription.payment",
      invoiceId: inv.id,
      status: "succeeded",
      amountMinor: 580_000,
      currency: "KES",
    };
    expect((await S.webhook(ev, { signature: "t=1,v1=" + "0".repeat(64) })).status).toBe(401);
    expect((await S.webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await S.webhook(ev, { provider: "nope" })).status).toBe(404);
    expect((await S.webhook({ ...ev, id: "ev-fail", status: "failed", reason: "card declined" })).body.result).toMatch(
      /failed/,
    );
    expect((await S.webhook({ ...ev, id: "ev-short", amountMinor: 10_000 })).body.result).toMatch(/Held for review/);
    expect((await S.webhook({ ...ev, id: "ev-ccy", currency: "USD" })).body.result).toMatch(/Held for review/);
    expect((await S.webhook({ ...ev, id: "ev-unknown-type", type: "nothing.here" })).status).toBe(400);
    expect((await post(A, "/test-property/leads", { name: "Grace" })).status).toBe(403);

    const ok = await S.webhook({ ...ev, id: "ev-ok", ref: "CARD-778812" });
    expect(ok.body.result).toMatch(/Applied/);
    expect(ok.body.receiptId).toBeTruthy();
    const replay = await S.webhook({ ...ev, id: "ev-ok", ref: "CARD-778812" });
    expect(replay.body.duplicate).toBe(true);
    const sub = await A.admin.api.subscriptions.get({ params: { orgId: A.orgId } });
    expect(sub.receipts.length).toBe(1);
    expect(sub.modules.crm!.source).toBe("addon");
    expect(sub.invoices.find((i) => i.id === inv.id)!.status).toBe("Paid");
    expect((await post(A, "/test-property/leads", { name: "Grace" })).status).toBe(201);
    // every attempt is kept with its outcome
    const events = await S.sql<{ id: string; result: string }>(
      "SELECT id, result FROM payment_events ORDER BY received_at",
    );
    expect(events.map((e) => e.id)).toEqual(
      expect.arrayContaining(["testpay:ev-fail", "testpay:ev-short", "testpay:ev-ccy", "testpay:ev-ok"]),
    );
  });

  it("a module already included or already active is never charged again; one not offered cannot be bought", async () => {
    const inc = await refused(
      B.admin.api.subscriptions.buyAddon({ params: { orgId: B.orgId }, body: { module: "crm", confirm: "CONFIRM" } }),
      409,
    );
    expect(inc.details.included).toBe(true);
    await refused(
      A.admin.api.subscriptions.buyAddon({
        params: { orgId: A.orgId },
        body: { module: "finance", confirm: "CONFIRM" },
      }),
      409,
    );
    await refused(
      A.admin.api.subscriptions.buyAddon({ params: { orgId: A.orgId }, body: { module: "crm", confirm: "CONFIRM" } }),
      409,
    );
    await refused(
      C.admin.api.subscriptions.buyAddon({ params: { orgId: C.orgId }, body: { module: "maint", confirm: "CONFIRM" } }),
      400,
    );
  });

  it("upgrade: after payment the plan includes the add-on, so it drops off the bill", async () => {
    const r = await A.admin.api.subscriptions.changePlan({
      params: { orgId: A.orgId },
      body: { plan: "PM-GROWTH", confirm: "CONFIRM" },
    });
    if (!("invoice" in r) || !r.invoice) throw new Error("expected an invoice");
    await pay("ev-up", r.invoice, "CARD-778813");
    const sub = await A.admin.api.subscriptions.get({ params: { orgId: A.orgId } });
    expect(sub.plan.id).toBe("PM-GROWTH");
    expect(sub.modules.crm!.source).toBe("plan");
    expect(sub.monthly.lines.some((l) => l.kind === "addon")).toBe(false);
    expect(sub.monthly.totalMinor).toBe(6_960_000); // KES 60,000 + 16%
  });

  it("buildings up to the allowance, then an extra allowance only after payment", async () => {
    for (const n of ["Riverside", "Westlands", "Kileleshwa"])
      expect((await post(A, "/test-property/buildings", { name: n })).status).toBe(201);
    const fourth = await post(A, "/test-property/buildings", { name: "Upper Hill" });
    expect(fourth.status).toBe(402);
    expect(fourth.body.error.code).toBe("ALLOWANCE_EXCEEDED");
    expect(fourth.body.error.details.extraPrice.amount).toBe(12000);
    const buy = await A.admin.api.subscriptions.buyAllowance({
      params: { orgId: A.orgId },
      body: { confirm: "CONFIRM" },
    });
    expect((await post(A, "/test-property/buildings", { name: "Upper Hill" })).status).toBe(402);
    expect((await pay("ev-bld", buy.invoice!, "CARD-778814")).body.result).toMatch(/Applied/);
    expect((await post(A, "/test-property/buildings", { name: "Upper Hill" })).status).toBe(201);
    expect((await post(A, "/test-property/buildings", { name: "Fifth" })).status).toBe(402);
  });

  it("a downgrade is refused while more buildings are in use than the smaller plan allows", async () => {
    const r = await refused(
      A.admin.api.subscriptions.changePlan({
        params: { orgId: A.orgId },
        body: { plan: "PM-STARTER", confirm: "CONFIRM" },
      }),
      400,
    );
    expect(r.message).toMatch(/You use 4 buildings/);
  });

  it("organisation, product and role isolation", async () => {
    expect((await get(B, "/test-property/buildings", A.admin.token)).status).toBe(404); // another company looks like nothing
    await refused(A.admin.api.organisations.get({ params: { orgId: B.orgId } }), 404);
    await refused(A.admin.api.ledger.trialBalance({ params: { orgId: B.orgId } }), 404);
    expect((await get(A, "/test-developer/projects")).status).toBe(404); // Property Management cannot open Development
    expect((await get(C, "/test-property/buildings")).status).toBe(404);
    const v = await S.addMember(A.orgId, A.admin.api, "viewer");
    expect((await get(A, "/test-property/buildings", v.token)).status).toBe(200);
    const w = await S.raw("POST", `/api/v1/orgs/${A.orgId}/test-property/buildings`, { name: "X" }, v.token);
    expect([w.status, w.body.error.code]).toEqual([403, "ROLE_NOT_ALLOWED"]);
    await refused(
      v.api.subscriptions.buyAddon({ params: { orgId: A.orgId }, body: { module: "automation", confirm: "CONFIRM" } }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const staffEmail = (
      await S.sql<{ email: string }>("SELECT email FROM users WHERE staff_role IS NOT NULL LIMIT 1")
    )[0]!.email;
    await refused(
      A.admin.api.organisations.addMember({
        params: { orgId: A.orgId },
        body: { email: staffEmail, role: "org_admin" },
      }),
      400,
    );
  });

  it("cancelling an add-on ends it on the next billing date and keeps the records", async () => {
    const r = await C.admin.api.subscriptions.buyAddon({
      params: { orgId: C.orgId },
      body: { module: "automation", confirm: "CONFIRM" },
    });
    await pay("ev-auto", r.invoice!, "CARD-990001");
    expect((await C.admin.api.subscriptions.entitlements({ params: { orgId: C.orgId } })).modules.automation).toBe(
      true,
    );
    const c = await C.admin.api.subscriptions.cancelAddon({ params: { orgId: C.orgId, module: "automation" } });
    expect(c.effective).toBe("2026-11-11");
    expect((await C.admin.api.subscriptions.entitlements({ params: { orgId: C.orgId } })).modules.automation).toBe(
      true,
    );
    await refused(C.admin.api.subscriptions.cancelAddon({ params: { orgId: C.orgId, module: "crm" } }), 409);
    await refused(C.admin.api.subscriptions.cancelAddon({ params: { orgId: C.orgId, module: "automation" } }), 409);
    S.setToday("2026-11-12");
    expect((await C.admin.api.subscriptions.entitlements({ params: { orgId: C.orgId } })).modules.automation).toBe(
      false,
    );
    S.setToday(TODAY);
  });

  it("a downgrade keeps data: records of a module no longer included stay readable", async () => {
    expect((await post(B, "/test-property/leads", { name: "Kept Lead" })).status).toBe(201);
    const r = await B.admin.api.subscriptions.changePlan({
      params: { orgId: B.orgId },
      body: { plan: "PM-STARTER", confirm: "CONFIRM" },
    });
    if (!("scheduled" in r)) throw new Error("expected a scheduled downgrade");
    expect(r.readOnlyAfter).toContain("Advanced CRM and Marketing");
    S.setToday("2026-11-20");
    expect((await B.admin.api.subscriptions.entitlements({ params: { orgId: B.orgId } })).plan).toBe("PM-STARTER");
    expect((await get(B, "/test-property/leads")).body).toEqual(["Kept Lead"]);
    expect((await post(B, "/test-property/leads", { name: "New" })).status).toBe(403);
    S.setToday(TODAY);
  });

  it("a scheduled change can be withdrawn before it takes effect", async () => {
    const sub = await B.admin.api.subscriptions.get({ params: { orgId: B.orgId } });
    const pending = sub.pending.find((p) => p.type === "plan")!;
    await B.admin.api.subscriptions.withdrawPending({ params: { orgId: B.orgId, pendingId: pending.id! } });
    S.setToday("2026-11-20");
    expect((await B.admin.api.subscriptions.entitlements({ params: { orgId: B.orgId } })).plan).toBe("PM-GROWTH");
    S.setToday(TODAY);
    await refused(
      B.admin.api.subscriptions.withdrawPending({ params: { orgId: B.orgId, pendingId: pending.id! } }),
      404,
    );
  });

  it("trial expiry blocks changes, keeps records, and a paid renewal restores access", async () => {
    const D = await S.newOrg({ name: "Delta Homes", plan: "PM-STARTER", trial: true });
    expect((await post(D, "/test-property/buildings", { name: "Delta One" })).status).toBe(201);
    const accountant = await S.addMember(D.orgId, D.admin.api, "accountant");
    S.setToday("2026-11-30");
    const blocked = await post(D, "/test-property/buildings", { name: "Delta Two" });
    expect([blocked.status, blocked.body.error.code]).toEqual([402, "SUBSCRIPTION_INACTIVE"]);
    expect((await get(D, "/test-property/buildings")).body.length).toBe(1);
    await refused(
      accountant.api.ledger.createJournal({
        params: { orgId: D.orgId },
        body: {
          date: "2026-11-30",
          memo: "Blocked",
          lines: [
            { account: "1000", debitMinor: 100 },
            { account: "4000", creditMinor: 100 },
          ],
        },
      }),
      402,
      "SUBSCRIPTION_INACTIVE",
    );
    const renew = await D.admin.api.subscriptions.changePlan({
      params: { orgId: D.orgId },
      body: { plan: "PM-STARTER", confirm: "CONFIRM" },
    });
    if (!("invoice" in renew) || !renew.invoice) throw new Error("expected an invoice");
    await pay("ev-renew", renew.invoice, "CARD-990002");
    expect((await D.admin.api.subscriptions.entitlements({ params: { orgId: D.orgId } })).status).toBe("active");
    expect((await post(D, "/test-property/buildings", { name: "Delta Two" })).status).toBe(402); // allowance: Standard includes 1
    S.setToday(TODAY);
  });

  it("Super Admin catalogue changes are validated and audited; issued invoices are never rewritten", async () => {
    const base = {
      name: "Dev",
      product: "developer" as const,
      buildingsIncluded: 1,
      baseMinor: 8_000_000,
      currency: "KES",
      taxPct: 16,
    };
    expect(
      (
        await refused(
          sa.api.admin.savePlan({ params: { planId: "DEV-STD" }, body: { ...base, modules: ["maint"] } }),
          400,
        )
      ).message,
    ).toMatch(/not offered for developer/);
    expect(
      (
        await refused(
          sa.api.admin.savePlan({ params: { planId: "DEV-STD" }, body: { ...base, modules: ["payments"] } }),
          400,
        )
      ).message,
    ).toMatch(/needs Finance and Accounting/);
    await refused(sa.api.admin.saveModule({ params: { moduleKey: "crm" }, body: { excludes: ["finance"] } }), 400);
    await refused(sa.api.admin.saveModule({ params: { moduleKey: "nope" }, body: { available: false } }), 404);
    const ok = await sa.api.admin.savePlan({
      params: { planId: "PM-STARTER" },
      body: {
        name: "Property Management — Standard",
        tier: "Standard",
        product: "property",
        modules: ["maint", "finance", "docs"],
        buildingsIncluded: 1,
        baseMinor: 2_600_000,
        extraBuildingMinor: 1_500_000,
        currency: "KES",
        taxPct: 16,
        capSites: 2,
        capUnits: 100,
      },
    });
    expect(ok.created).toBe(false);
    const audit = await sa.api.admin.audit({ query: { limit: 200 } });
    const ch = audit.entries.find((x) => x.action === "Plan changed" && x.target === "PM-STARTER") as
      { before: { base_minor: number }; after: { base_minor: number } } | undefined;
    expect([ch?.before.base_minor, ch?.after.base_minor]).toEqual([2_500_000, 2_600_000]);
    const [inv] = await S.sql<{ total_minor: number }>("SELECT total_minor FROM billing_invoices WHERE id = $1", [
      A.crmInvoice,
    ]);
    expect(inv!.total_minor).toBe(580_000);
  });

  it("a manual receipt needs a unique bank reference and the exact invoice; it is recorded as manual", async () => {
    await refused(
      sa.api.admin.recordReceipt({
        params: { invoiceId: A.crmInvoice! },
        body: { ref: "CARD-778812", reason: "Duplicate attempt" },
      }),
      409,
    );
    const i = await sa.api.admin.issueInvoice({ params: { orgId: C.orgId }, body: {} });
    expect(i.product).toBe("developer");
    await refused(sa.api.admin.issueInvoice({ params: { orgId: C.orgId }, body: {} }), 409); // once per period
    const r = await sa.api.admin.recordReceipt({
      params: { invoiceId: i.id },
      body: { ref: "EFT-55102", reason: "Bank transfer seen on statement 12 Oct" },
    });
    expect(r.result).toMatch(/Applied/);
    const [ev] = await S.sql<{ manual: boolean; recorded_by: string }>(
      "SELECT manual, recorded_by FROM payment_events WHERE id = 'manual:eft-55102'",
    );
    expect(ev).toEqual({ manual: true, recorded_by: sa.userId });
    const receipts = (await C.admin.api.subscriptions.get({ params: { orgId: C.orgId } })).receipts;
    expect(receipts.find((x) => x.invoiceId === i.id)?.manual).toBe(true);
  });

  it("a product's own payment type reaches that product's handler", async () => {
    const r = await S.webhook({
      id: "p-1",
      type: "test.property.payment",
      status: "succeeded",
      amountMinor: 1234,
      currency: "KES",
      data: { orgId: A.orgId },
    });
    expect(r.body.result).toBe("Applied — test property payment 1234");
  });

  it("the Super Admin sees every organisation with its subscriptions", async () => {
    const list = await sa.api.admin.listOrganisations();
    const alpha = list.organisations.find((o) => o.id === A.orgId)!;
    expect(alpha.subscriptions).toEqual([
      { product: "property", plan: "PM-GROWTH", status: "active", trialEnds: null },
    ]);
  });
});
