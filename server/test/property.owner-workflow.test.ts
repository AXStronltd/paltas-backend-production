import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleCan } from "@paltas/contracts";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";

describe("new company owner's Property Management workflow", () => {
  let S: TestServer;
  let owner: Account;
  let stranger: Account;
  beforeAll(async () => {
    S = await signupServer();
    owner = await signUpAndIn(S, "property");
    stranger = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("keeps financial approvals separate from company administration", () => {
    for (const cap of ["property.leases.manage", "property.billing", "property.payments.record"] as const)
      expect(roleCan("org_admin", cap)).toBe(true);
    for (const cap of [
      "property.bills.approve",
      "property.bills.pay",
      "property.deposits.approve",
      "property.payouts.approve",
      "ledger.approve",
    ] as const)
      expect(roleCan("org_admin", cap)).toBe(false);
  });

  it("creates a lease, invoices rent, records a payment and persists records after login", async () => {
    const org = "/api/v1/orgs/" + owner.orgId;
    const base = org + "/property";
    const today = S.app.clock.today();
    async function post(path: string, body: unknown) {
      const r = await S.raw("POST", path, body, owner.token);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    }
    const property = await post(base + "/properties", { name: "Owner's first property", address: "Nairobi" });
    const units = await post(base + "/properties/" + property.id + "/units", { units: [{ unitNo: "A1" }] });
    const landlord = await post(org + "/contacts", {
      name: "Property owner",
      types: ["owner"],
      email: "landlord@workflow.test",
    });
    const tenant = await post(org + "/contacts", {
      name: "First tenant",
      types: ["tenant"],
      email: "tenant@workflow.test",
    });
    const owned = await post(base + "/ownerships", {
      propertyId: property.id,
      ownerId: landlord.contact.id,
      ownerType: "individual",
      evidenceRef: "Synthetic ownership evidence",
    });
    expect(
      (
        await S.raw(
          "POST",
          base + "/ownerships/" + owned.ownerships[0].id + "/verify",
          { confirm: "VERIFIED" },
          owner.token,
        )
      ).status,
    ).toBe(200);
    const authority = await post(base + "/agreements", {
      propertyId: property.id,
      ownerId: landlord.contact.id,
      ownershipId: owned.ownerships[0].id,
      managementCompany: "Synthetic company",
      evidenceRef: "Synthetic signed agreement",
      feePct: 10,
      authorityMinor: 0,
      startDate: today,
    });
    expect(
      (
        await S.raw(
          "POST",
          base + "/agreements/" + authority.id + "/activate",
          { confirm: "ACTIVATE", signedOn: today },
          owner.token,
        )
      ).status,
    ).toBe(200);
    const lease = await post(base + "/leases", {
      unitId: units.units[0].id,
      tenantId: tenant.contact.id,
      startDate: today,
      rentMinor: 2500000,
      depositMinor: 0,
      depositMode: "none",
    });
    const activated = await S.raw("POST", base + "/leases/" + lease.id + "/activate", { signedOn: today }, owner.token);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    await post(base + "/billing-runs", { propertyId: property.id, period: today.slice(0, 7), kind: "rent" });
    const before = await S.raw("GET", base + "/invoices", undefined, owner.token);
    expect(before.status).toBe(200);
    expect(before.body.invoices.length).toBeGreaterThan(0);
    const amount = before.body.invoices.reduce(
      (sum: number, invoice: { balanceMinor: number }) => sum + invoice.balanceMinor,
      0,
    );
    const payment = await post(base + "/payments", {
      tenantId: tenant.contact.id,
      date: today,
      amountMinor: amount,
      method: "bank_transfer",
      reference: "OWNER-WORKFLOW-001",
    });
    expect(payment.receiptNumber).toBeTruthy();
    await post(base + "/billing-runs", { propertyId: property.id, period: today.slice(0, 7), kind: "rent" });
    const fresh = await S.login(owner.email, owner.password);
    const after = await S.raw("GET", base + "/invoices", undefined, fresh.token);
    expect(after.body.invoices).toHaveLength(before.body.invoices.length);
    expect(after.body.invoices.every((invoice: { balanceMinor: number }) => invoice.balanceMinor === 0)).toBe(true);
    const payments = await S.raw("GET", base + "/payments", undefined, fresh.token);
    expect(payments.body.payments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: payment.id, receiptNumber: payment.receiptNumber })]),
    );
    expect((await S.raw("GET", base + "/leases/" + lease.id, undefined, stranger.token)).status).toBe(404);
    expect((await S.raw("GET", base + "/invoices", undefined, stranger.token)).status).toBe(404);
    expect((await S.raw("GET", base + "/payments", undefined, stranger.token)).status).toBe(404);
  });
});
