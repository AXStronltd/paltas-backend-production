import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupServer } from "./support/signup-fixture.js";
import { TODAY, type TestServer } from "./support/test-server.js";
import { resolveEntitlement } from "../dist/core/subscriptions/entitlement.service.js";
import { monthlyChargeMinor } from "../dist/core/subscriptions/billing.service.js";

describe("approved USD software subscription alongside KES operations", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await signupServer();
  });
  afterAll(async () => {
    if (S) await S.close();
  });
  it("quotes, invoices and renews in USD without rewriting operational currency", async () => {
    const id = "paltas_property_standard_20261027";
    // Local fixture only: synthetic tax note, never published or deployed.
    await S.sql(
      `INSERT INTO catalogue_plans SELECT (jsonb_populate_record(NULL::catalogue_plans,
      to_jsonb(p) || $2::jsonb)).* FROM catalogue_plans p WHERE p.id=$1`,
      [
        "PM-STARTER",
        JSON.stringify({
          id,
          name: "Approved USD fixture",
          currency: "USD",
          base_minor: 4900,
          tax_pct: 0,
          tax_note: "Isolated test fixture",
          frequency: "monthly",
        }),
      ],
    );
    const { orgId, admin } = await S.newOrg({ currency: "KES" });
    const options = await admin.api.subscriptions.upgradeOptions({ params: { orgId }, query: {} });
    expect(options.plans.find((p) => p.id === id)?.price).toEqual({ amountMinor: 4900, currency: "USD", per: "month" });
    const result = await admin.api.subscriptions.upgrade({
      params: { orgId },
      body: { plan: id, frequency: "monthly", payment: "provider", confirm: "CONFIRM" },
    });
    expect(result.invoice?.currency).toBe("USD");
    expect(result.purchase.currency).toBe("USD");
    expect(result.invoice?.totalMinor).toBe(4900);
    expect((await S.sql("SELECT currency FROM organisations WHERE id=$1", [orgId]))[0].currency).toBe("KES");
    // Only a verified provider event activates the selected plan, as in the existing engine.
    await S.webhook({
      id: "usd-fixture-paid",
      type: "subscription.payment",
      invoiceId: result.invoice!.id,
      currency: "USD",
      amountMinor: 4900,
      status: "succeeded",
      ref: "TEST-USD-ONLY",
    });
    const context = await resolveEntitlement(S.app.ctx.db, S.app.ctx.products, TODAY, orgId, "property");
    expect(context?.ent.plan.id).toBe(id);
    const monthly = monthlyChargeMinor(context!, TODAY);
    expect(monthly.charge.currency).toBe("USD");
    expect(monthly.charge.totalMinor).toBe(4900);
    expect(context?.org.currency).toBe("KES");
  });
});
