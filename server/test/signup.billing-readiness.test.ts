import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupServer, signUpAndIn, verificationToken, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("Production catalogue readiness before self-service invoicing", () => {
  let S: TestServer, a: Account;
  beforeAll(async () => {
    S = await signupServer();
    a = await signUpAndIn(S, "property");
    await S.api.signup.verify({ body: { token: await verificationToken(S, a.email) } });
    S.app.ctx.config.env = "production";
    S.app.ctx.config.signup.appBaseUrl = "https://paltas.io";
  });
  afterAll(async () => {
    await S?.close();
  });
  it("offers assisted quotes for placeholder taxes and creates no invoice", async () => {
    await S.sql(
      "UPDATE catalogue_plans SET tax_pct=16,tax_note='Demo VAT configuration' WHERE id='PALTAS-20261027-property-Standard'",
    );
    const options = await a.api.subscriptions.upgradeOptions({
      params: { orgId: a.orgId },
      query: { product: "property" },
    });
    expect(options.plans.find((p) => p.id === "PALTAS-20261027-property-Standard")?.contactSales).toBe(true);
    await expect(
      a.api.subscriptions.upgrade({
        params: { orgId: a.orgId },
        body: {
          plan: "PALTAS-20261027-property-Standard",
          frequency: "monthly",
          payment: "bank_transfer",
          confirm: "CONFIRM",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await S.sql("SELECT 1 FROM billing_invoices WHERE org_id=$1", [a.orgId])).toHaveLength(0);
  });
  it("keeps an explicitly configured non-placeholder test catalogue available", async () => {
    await S.sql(
      "UPDATE catalogue_plans SET tax_pct=0,tax_note='Configured billing policy' WHERE id='PALTAS-20261027-property-Standard'",
    );
    const options = await a.api.subscriptions.upgradeOptions({
      params: { orgId: a.orgId },
      query: { product: "property" },
    });
    expect(options.plans.find((p) => p.id === "PALTAS-20261027-property-Standard")?.contactSales).toBe(false);
    const order = await a.api.subscriptions.upgrade({
      params: { orgId: a.orgId },
      body: {
        plan: "PALTAS-20261027-property-Standard",
        frequency: "monthly",
        payment: "bank_transfer",
        confirm: "CONFIRM",
      },
    });
    expect(order.invoice?.status).toBe("Open");
  });
});
