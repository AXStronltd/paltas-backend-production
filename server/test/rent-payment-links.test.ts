import { beforeAll, afterAll, it, expect } from "vitest";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";
import { pmAccess } from "../dist/products/property/shared/access.js";
import { paymentLinks } from "../dist/core/payments/kulmipay/payment-links.js";
import { kulmiPayService } from "../dist/core/payments/kulmipay/service.js";
import { kulmiPayClient } from "../dist/core/payments/kulmipay/client.js";
let S: TestServer, o: Awaited<ReturnType<typeof pmOrg>>, invoiceId: string, token: string, linkId: string;
const accountNumber = "001234567890",
  params = () => ({ orgId: o.orgId });
const create = () =>
  o.admin.api.rentCollection.createPaymentLink({
    params: { ...params(), invoiceId },
    body: { expiresDays: 3, includeManualInstructions: true, confirmShare: true },
  });
beforeAll(async () => {
  S = await startPropertyServer({ kulmiPay: { enabled: true } });
  S.setToday("2026-10-29");
  o = await pmOrg(S);
  const b = await setUpBuilding(o.orgId, o.admin),
    tenantId = await newTenant(o.admin, o.orgId, "Private Synthetic Tenant");
  const l = await o.admin.api.property.createLease({
    params: params(),
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 120000, dueDay: 5 },
  });
  await o.admin.api.property.activateLease({
    params: { ...params(), leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  invoiceId = (
    await S.sql<{ id: string }>("SELECT id FROM pm_invoices WHERE org_id=$1 AND tenant_id=$2", [o.orgId, tenantId])
  )[0]!.id;
});
afterAll(() => S.close());
it("does not issue a link without a ready method; enforces owner-only instruction confirmation", async () => {
  await refused(create(), 409);
  await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: {
      expectedRevision: 0,
      kind: "bank",
      accountHolder: "Synthetic Company",
      accountNumber,
      bankCode: "68",
      reason: "Register business account",
      confirmAuthority: true,
    },
  });
  await refused(create(), 409);
  const body = {
    expectedRevision: 1,
    confirmAuthority: true as const,
    confirmShare: true as const,
    reason: "Checked company instructions for sharing",
  };
  await refused(o.staff.accountant.api.rentCollection.confirmReceivingInstructions({ params: params(), body }), 403);
  expect(await o.admin.api.rentCollection.confirmReceivingInstructions({ params: params(), body })).toEqual({
    manualInstructionsEnabled: true,
  });
  await refused(
    o.staff.viewer.api.rentCollection.createPaymentLink({
      params: { ...params(), invoiceId },
      body: { expiresDays: 3, includeManualInstructions: true, confirmShare: true },
    }),
    403,
  );
});
it("creates an expiring fragment link, stores only its hash, and shows only the intended invoice", async () => {
  const r = await create();
  token = new URL(r.url).hash.slice(1);
  linkId = r.id;
  expect(token).toHaveLength(43);
  expect(new URL(r.url).pathname).toBe("/pay.html");
  expect(new URL(r.url).search).toBe("");
  const row = (
    await S.sql<{ token_hash: string }>("SELECT token_hash FROM pm_invoice_payment_links WHERE id=$1", [linkId])
  )[0]!;
  expect(row.token_hash).not.toBe(token);
  expect(row.token_hash).toHaveLength(64);
  const v = await o.admin.api.rentCollection.previewPaymentLink({ body: { token } });
  expect(v).toMatchObject({
    balanceMinor: 120000,
    currency: "KES",
    mpesaAvailable: false,
    manualInstructions: { kind: "bank", accountNumber, bankCode: "68" },
    receiptRecorded: false,
  });
  expect(JSON.stringify(v)).not.toContain("Private Synthetic Tenant");
  const response = await fetch(S.base + "/api/v1/public/rent-payment-links/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
it("rejects forged tokens, wrong organisations and unsupported automatic collection", async () => {
  const other = await pmOrg(S);
  await refused(
    other.admin.api.rentCollection.revokePaymentLink({
      params: { orgId: other.orgId, linkId },
      body: { reason: "Attempt another company link" },
    }),
    404,
  );
  await refused(o.admin.api.rentCollection.previewPaymentLink({ body: { token: "x".repeat(43) } }), 404);
  await refused(
    o.admin.api.rentCollection.collectPaymentLink({
      body: { token, phone: "254712345678", expectedAmountMinor: 120000, confirm: true },
    }),
    409,
  );
  expect(await S.sql("SELECT id FROM pm_payments WHERE org_id=$1", [o.orgId])).toHaveLength(0);
});
it("revokes and expires links without changing invoices", async () => {
  const a = await create();
  await o.admin.api.rentCollection.revokePaymentLink({
    params: { ...params(), linkId: a.id },
    body: { reason: "Replace shared invoice request" },
  });
  await refused(o.admin.api.rentCollection.previewPaymentLink({ body: { token: new URL(a.url).hash.slice(1) } }), 404);
  const b = await create();
  await S.sql("UPDATE pm_invoice_payment_links SET expires_at=now()-interval '1 day' WHERE id=$1", [b.id]);
  await refused(o.admin.api.rentCollection.previewPaymentLink({ body: { token: new URL(b.url).hash.slice(1) } }), 404);
});
it("permission revocation immediately invalidates issued links", async () => {
  await S.sql("UPDATE memberships SET status='suspended' WHERE org_id=$1 AND user_id=$2", [o.orgId, o.admin.userId]);
  await expect(
    paymentLinks({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) }).preview(token),
  ).rejects.toThrow(/unavailable/);
  await S.sql("UPDATE memberships SET status='active' WHERE org_id=$1 AND user_id=$2", [o.orgId, o.admin.userId]);
});
it("changing the receiving destination invalidates old instructions until reconfirmed", async () => {
  await o.admin.api.rentCollection.saveReceivingAccount({
    params: params(),
    body: {
      expectedRevision: 1,
      kind: "mpesa_paybill",
      accountHolder: "Synthetic Company",
      accountNumber: "123456",
      accountReference: "RENT",
      reason: "Use company PayBill instructions",
      confirmAuthority: true,
    },
  });
  await refused(o.admin.api.rentCollection.previewPaymentLink({ body: { token } }), 409);
  await refused(create(), 409);
  await o.admin.api.rentCollection.confirmReceivingInstructions({
    params: params(),
    body: { expectedRevision: 2, reason: "Check company PayBill details", confirmAuthority: true, confirmShare: true },
  });
  const r = await create(),
    v = await o.admin.api.rentCollection.previewPaymentLink({ body: { token: new URL(r.url).hash.slice(1) } });
  expect(v.manualInstructions).toMatchObject({
    kind: "mpesa_paybill",
    accountNumber: "123456",
    accountReference: "RENT",
  });
});
it("shares M-Pesa mobile and Till instructions only after explicit confirmation", async () => {
  for (const [kind, number, revision] of [
    ["mpesa_mobile", "254712345678", 3],
    ["mpesa_till", "654321", 4],
  ] as const) {
    await o.admin.api.rentCollection.saveReceivingAccount({
      params: params(),
      body: {
        expectedRevision: revision - 1,
        kind,
        accountHolder: "Synthetic Company",
        accountNumber: number,
        reason: "Change manual receiving method",
        confirmAuthority: true,
      },
    });
    await refused(create(), 409);
    await o.admin.api.rentCollection.confirmReceivingInstructions({
      params: params(),
      body: {
        expectedRevision: revision,
        reason: "Confirm receiving instructions",
        confirmAuthority: true,
        confirmShare: true,
      },
    });
    const r = await create();
    expect(
      (await o.admin.api.rentCollection.previewPaymentLink({ body: { token: new URL(r.url).hash.slice(1) } }))
        .manualInstructions,
    ).toMatchObject({ kind, accountNumber: number });
  }
});
it("M-Pesa link uses the shared request, verified receipt and duplicate guards", async () => {
  const deps = { ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) };
  let reference = "",
    state = "PENDING",
    calls = 0;
  const client = kulmiPayClient(async (url, init) => {
    if (url.includes("wallets/")) return Response.json({ wallet_id: "synthetic_wallet", currency: "KES" });
    const b = JSON.parse(String(init.body));
    if (url.includes("stk-push")) {
      reference = b.api_ref;
      calls++;
    }
    return Response.json({
      invoice: {
        invoice_id: "synthetic_paylink_invoice",
        api_ref: reference,
        state,
        provider: "M-PESA",
        currency: "KES",
        value: "1200.00",
        charges: "30.00",
        net_amount: "1170.00",
        updated_at: "2026-10-29T10:00:00Z",
      },
    });
  });
  const c = kulmiPayService(deps, client),
    links = paymentLinks(deps, c),
    scope = await pmAccess(S.app.core).org(
      (await S.app.core.identity.authenticate(o.admin.token))!,
      o.orgId,
      "property.payments.record",
      { write: true, module: "finance" },
    );
  await c.connect(scope, {
    environment: "sandbox",
    walletId: "synthetic_wallet",
    secretKey: "ISSecretKey_test_synthetic_only",
    challenge: "synthetic_challenge_at_least_32_chars",
  });
  const r = await links.create(scope, invoiceId, {
      expiresDays: 3,
      includeManualInstructions: false,
      confirmShare: true,
    }),
    t = new URL(r.url).hash.slice(1);
  expect((await links.preview(t)).mpesaAvailable).toBe(true);
  await expect(
    links.collect({ token: t, phone: "254712345678", expectedAmountMinor: 1, confirm: true }),
  ).rejects.toThrow(/balance changed/);
  expect(calls).toBe(0);
  const pending = await links.collect({ token: t, phone: "254712345678", expectedAmountMinor: 120000, confirm: true });
  expect(pending).toMatchObject({ paymentState: "PENDING", receiptRecorded: false });
  expect(calls).toBe(1);
  await expect(
    links.collect({ token: t, phone: "254712345678", expectedAmountMinor: 120000, confirm: true }),
  ).rejects.toThrow(/already exists/);
  expect(calls).toBe(1);
  state = "COMPLETE";
  expect(await links.refresh(t)).toMatchObject({
    balanceMinor: 0,
    receiptRecorded: true,
    paymentState: "COMPLETE",
    mpesaAvailable: false,
  });
  await links.refresh(t);
  expect(await S.sql("SELECT id FROM pm_payments WHERE org_id=$1", [o.orgId])).toHaveLength(1);
});
