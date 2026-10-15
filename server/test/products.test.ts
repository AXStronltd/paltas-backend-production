// Property Management and Real Estate Development as two products: independent, and together in one organisation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProducts } from "./support/fake-products.js";
import { refused, startServer, type Person, type TestServer } from "./support/test-server.js";

describe("two products: separate subscriptions that never activate each other", () => {
  let S: TestServer;
  let sa: Awaited<ReturnType<TestServer["staff"]>>;
  let PMO: { orgId: string; admin: Person };
  let DVO: { orgId: string; admin: Person };
  const ent = (o: { orgId: string; admin: Person }, product?: "property" | "developer") =>
    o.admin.api.subscriptions.entitlements({ params: { orgId: o.orgId }, query: product ? { product } : {} });
  const post = (o: { orgId: string; admin: Person }, path: string, body: unknown) =>
    S.raw("POST", `/api/v1/orgs/${o.orgId}${path}`, body, o.admin.token);
  const get = (o: { orgId: string; admin: Person }, path: string) =>
    S.raw("GET", `/api/v1/orgs/${o.orgId}${path}`, undefined, o.admin.token);

  beforeAll(async () => {
    S = await startServer({ products: fakeProducts().modules });
    sa = await S.staff();
    PMO = await S.newOrg({ name: "Kilima Property Managers", plan: "PM-STARTER", trial: false });
    DVO = await S.newOrg({ name: "Mto Developers", product: "developer", plan: "DEV-STD", trial: false });
  });
  afterAll(() => S.close());

  it("each product works on its own", async () => {
    expect((await post(PMO, "/test-property/buildings", { name: "Kilima Court" })).status).toBe(201);
    expect((await get(PMO, "/test-developer/projects")).status).toBe(404);
    expect((await post(DVO, "/test-developer/projects", { name: "Mto Heights" })).status).toBe(201);
    expect((await get(DVO, "/test-property/buildings")).status).toBe(404);
    expect((await ent(PMO)).products).toEqual(["property"]);
  });

  it("a plan for one product never changes or creates the other", async () => {
    const r = await refused(
      PMO.admin.api.subscriptions.changePlan({
        params: { orgId: PMO.orgId },
        body: { plan: "DEV-STD", confirm: "CONFIRM" },
      }),
      400,
    );
    expect(r.details.addProduct).toBe("developer");
    expect((await ent(PMO)).products).toEqual(["property"]);
    expect((await ent(PMO)).plan).toBe("PM-STARTER");
  });

  it("adding Development is an explicit, separate subscription", async () => {
    expect((await post(PMO, "/products", { product: "developer", plan: "DEV-STD" })).status).toBe(400); // needs confirmation
    await refused(
      PMO.admin.api.subscriptions.addProduct({
        params: { orgId: PMO.orgId },
        body: { product: "developer", plan: "PM-GROWTH", confirm: "CONFIRM" },
      }),
      400,
    );
    const r = await PMO.admin.api.subscriptions.addProduct({
      params: { orgId: PMO.orgId },
      body: { product: "developer", plan: "DEV-STD", confirm: "CONFIRM" },
    });
    expect([r.status, r.trialEnds]).toEqual(["trial", "2026-11-10"]);
    await refused(
      PMO.admin.api.subscriptions.addProduct({
        params: { orgId: PMO.orgId },
        body: { product: "developer", plan: "DEV-STD", confirm: "CONFIRM" },
      }),
      409,
    );
    const pm = await ent(PMO, "property");
    const dv = await ent(PMO, "developer");
    expect(pm.products).toEqual(["property", "developer"]);
    expect([pm.plan, pm.status, dv.plan, dv.status]).toEqual(["PM-STARTER", "active", "DEV-STD", "trial"]);
    expect((await post(PMO, "/test-developer/projects", { name: "Kilima Gardens Phase 1" })).status).toBe(201);
    expect((await get(PMO, "/test-property/buildings")).body.length).toBe(1);
    const list = await PMO.admin.api.subscriptions.listProducts({ params: { orgId: PMO.orgId } });
    expect(list.products.filter((x) => x.subscribed).map((x) => x.product)).toEqual(["property", "developer"]);
    const offer = await DVO.admin.api.subscriptions.listProducts({ params: { orgId: DVO.orgId } });
    const pmOffer = offer.products.find((p) => p.product === "property")!;
    expect(pmOffer.subscribed).toBe(false);
    expect(pmOffer.offer!.find((o) => o.id === "PM-STARTER")!.price).toEqual({
      amountMinor: 2_500_000,
      currency: "KES",
      per: "month",
    });
  });

  it("entitlements are per product: CRM in the Development plan does not unlock it in Property Management", async () => {
    expect((await ent(PMO, "developer")).modules.crm).toBe(true);
    expect((await ent(PMO, "property")).modules.crm).toBe(false);
    expect((await post(PMO, "/test-property/leads", { name: "Grace" })).body.error.code).toBe("MODULE_NOT_ENTITLED");
    const q = await PMO.admin.api.subscriptions.buyAddon({
      params: { orgId: PMO.orgId },
      body: { module: "crm", confirm: "CONFIRM", product: "property" },
    });
    expect(q.invoice!.product).toBe("property");
    await S.webhook({
      id: "two-crm",
      type: "subscription.payment",
      invoiceId: q.invoice!.id,
      status: "succeeded",
      amountMinor: q.invoice!.totalMinor,
      currency: "KES",
      ref: "CARD-TWO-1",
    });
    expect((await ent(PMO, "property")).modules.crm).toBe(true);
    await refused(
      PMO.admin.api.subscriptions.buyAddon({
        params: { orgId: PMO.orgId },
        body: { module: "crm", confirm: "CONFIRM", product: "developer" },
      }),
      409,
    );
  });

  it("an organisation-wide module is bought once and covers both products", async () => {
    await sa.api.admin.saveModule({ params: { moduleKey: "docs" }, body: { scope: "organisation" } });
    const dv = await ent(PMO, "developer");
    expect([dv.modules.docs, dv.sources.docs]).toEqual([true, "organisation"]);
    const r = await refused(
      PMO.admin.api.subscriptions.buyAddon({
        params: { orgId: PMO.orgId },
        body: { module: "docs", confirm: "CONFIRM", product: "developer" },
      }),
      409,
    );
    expect(r.message).toMatch(/whole organisation/);
    const sub = await PMO.admin.api.subscriptions.get({
      params: { orgId: PMO.orgId },
      query: { product: "developer" },
    });
    expect(sub.monthly.lines.some((l) => /Document/.test(l.what))).toBe(false);
    await sa.api.admin.saveModule({ params: { moduleKey: "docs" }, body: { scope: "product" } });
    expect((await ent(PMO, "developer")).modules.docs).toBe(false);
    expect((await S.raw("PUT", "/api/v1/admin/modules/docs", { scope: "everyone" }, sa.token)).status).toBe(400);
  });

  it("separate invoices, separate status, separate cancellation", async () => {
    const i1 = await sa.api.admin.issueInvoice({ params: { orgId: PMO.orgId }, body: { product: "property" } });
    expect(i1.product).toBe("property");
    const subP = await PMO.admin.api.subscriptions.get({
      params: { orgId: PMO.orgId },
      query: { product: "property" },
    });
    const subD = await PMO.admin.api.subscriptions.get({
      params: { orgId: PMO.orgId },
      query: { product: "developer" },
    });
    expect(
      subP.invoices.every((i) => i.product === "property") && subD.invoices.every((i) => i.product === "developer"),
    ).toBe(true);
    await sa.api.admin.setSubscriptionStatus({
      params: { orgId: PMO.orgId },
      body: { status: "suspended", product: "developer", reason: "Ticket T-77 test" },
    });
    expect((await post(PMO, "/test-developer/projects", { name: "Blocked" })).body.error.code).toBe(
      "SUBSCRIPTION_INACTIVE",
    );
    expect((await get(PMO, "/test-developer/projects")).status).toBe(200);
    expect((await post(PMO, "/test-property/leads", { name: "Still works" })).status).toBe(201);
    await sa.api.admin.setSubscriptionStatus({
      params: { orgId: PMO.orgId },
      body: { status: "trial", product: "developer", reason: "Ticket T-77 restored" },
    });
    const c = await PMO.admin.api.subscriptions.cancel({
      params: { orgId: PMO.orgId },
      body: { reason: "Moving buildings to another manager", product: "property" },
    });
    expect(c.product).toBe("property");
    await refused(
      PMO.admin.api.subscriptions.cancel({
        params: { orgId: PMO.orgId },
        body: { reason: "again", product: "property" },
      }),
      409,
    );
    expect((await ent(PMO, "developer")).status).toBe("trial");
  });

  it("roles of both products for an organisation that holds both", async () => {
    await PMO.admin.api.organisations.addMember({
      params: { orgId: PMO.orgId },
      body: { email: "sales@kilima.test", role: "sales_agent" },
    });
    await PMO.admin.api.organisations.addMember({
      params: { orgId: PMO.orgId },
      body: { email: "pm@kilima.test", role: "property_manager" },
    });
    const r = await refused(
      DVO.admin.api.organisations.addMember({
        params: { orgId: DVO.orgId },
        body: { email: "pm@mto.test", role: "property_manager" },
      }),
      400,
    );
    expect(r.message).toMatch(/Role must be one of/);
  });

  it("the product's own ledger accounts are added when the product is added", async () => {
    const chart = await DVO.admin.api.ledger.listAccounts({ params: { orgId: DVO.orgId } });
    expect(chart.accounts.some((a) => a.code === "1010")).toBe(false); // Development-only: no client account
    const pm = await PMO.admin.api.ledger.listAccounts({ params: { orgId: PMO.orgId } });
    expect(pm.accounts.some((a) => a.code === "1010")).toBe(true);
  });
});
