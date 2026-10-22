// Local fake provider only. No real recipients, production money or credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";
import { fakeHttpProvider } from "./support/fake-email.js";
import { newTenant, pmOrg, setUpBuilding, startPropertyServer, type PmStaff } from "./support/property-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("Tenant invoice email: preview, confirmation, isolation and honest delivery", () => {
  let S: TestServer, fake: Awaited<ReturnType<typeof fakeHttpProvider>>;
  let orgId: string, st: PmStaff, tenantId: string, invoiceId: string;
  const params = () => ({ orgId, invoiceId });
  beforeAll(async () => {
    fake = await fakeHttpProvider(() => [200, { id: "local-invoice-email" }]);
    const email = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://unused",
      PLATFORM_EMAIL_PROVIDER: "resend",
      PLATFORM_EMAIL_FROM: "PALTAS <billing@paltas.test>",
      RESEND_API_KEY: "re_test_only",
      PLATFORM_EMAIL_API_URL: fake.url,
    }).email;
    S = await startPropertyServer({ email });
    const o = await pmOrg(S);
    orgId = o.orgId;
    st = o.staff;
    const b = await setUpBuilding(orgId, st.property_manager);
    tenantId = await newTenant(st.property_manager, orgId, "Invoice Tenant");
    const l = await st.property_manager.api.property.createLease({
      params: { orgId },
      body: {
        tenantId,
        unitId: b.units["A-101"]!,
        startDate: "2026-10-01",
        rentMinor: 12000000,
        depositMinor: 0,
        depositMode: "none",
      },
    });
    await st.property_manager.api.property.activateLease({
      params: { orgId, leaseId: l.id },
      body: { signedOn: "2026-10-01", billFirstRent: false },
    });
    const r = await st.accountant.api.property.runBilling({
      params: { orgId },
      body: { propertyId: b.propertyId, period: "2026-10", kind: "rent" },
    });
    invoiceId = r.created[0]!.id;
  });
  afterAll(async () => {
    await S?.close();
    await fake?.close();
  });
  it("previews the registered tenant, correct major units and outstanding balance without sending", async () => {
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    expect(p.canSend).toBe(true);
    expect(p.recipient).toContain("invoice.tenant");
    expect(p.body).toContain("KES 120,000.00");
    expect(p.body).toContain("Outstanding:");
    expect(p.lastMessage).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect((await S.sql("SELECT count(*)::int n FROM notifications WHERE source='property_invoice'"))[0].n).toBe(0);
  });
  it("requires billing authority and rejects another organisation's invoice", async () => {
    await refused(st.viewer.api.property.previewInvoiceEmail({ params: params() }), 403);
    const other = await pmOrg(S);
    await refused(
      other.staff.accountant.api.property.previewInvoiceEmail({ params: { orgId: other.orgId, invoiceId } }),
      404,
    );
  });
  it("rejects a stale preview after a payment changes the invoice", async () => {
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    await st.accountant.api.property.recordPayment({
      params: { orgId },
      body: { tenantId, date: "2026-10-11", amountMinor: 1000000, method: "cash", reference: "LOCAL-EMAIL-1" },
    });
    await refused(
      st.accountant.api.property.sendInvoiceEmail({
        params: params(),
        body: { previewKey: p.previewKey, confirm: "SEND" },
      }),
      409,
    );
  });
  it("confirms once under concurrent retries, dispatches to the fake provider, never claims delivery", async () => {
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    const before = (await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n;
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        st.accountant.api.property.sendInvoiceEmail({
          params: params(),
          body: { previewKey: p.previewKey, confirm: "SEND" },
        }),
      ),
    );
    expect(a!.id).toBe(b!.id);
    expect(a!.status).toBe("recorded");
    expect((await S.sql("SELECT count(*)::int n FROM notifications WHERE source='property_invoice'"))[0].n).toBe(1);
    await S.app.core.notifications.dispatchPending();
    const r = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    expect(r.lastMessage?.status).toBe("sent");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.to).toEqual([p.recipient]);
    expect(fake.requests[0]!.body.text).toContain("Outstanding: KES 110,000.00");
    expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n).toBe(before);
  });
  it("honours a transactional email opt-out", async () => {
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    await S.sql(
      "INSERT INTO notification_consents (org_id,channel,address,purpose,granted,source) VALUES ($1,'email',$2,'transactional',false,'Local test')",
      [orgId, p.recipient],
    );
    // Changed invoice balance creates a new preview; the prior sent message stays untouched.
    await st.accountant.api.property.recordPayment({
      params: { orgId },
      body: { tenantId, date: "2026-10-11", amountMinor: 100, method: "cash", reference: "LOCAL-EMAIL-2" },
    });
    const next = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    const m = await st.accountant.api.property.sendInvoiceEmail({
      params: params(),
      body: { previewKey: next.previewKey, confirm: "SEND" },
    });
    expect(m.status).toBe("suppressed");
    await S.app.core.notifications.dispatchPending();
    expect(fake.requests).toHaveLength(1);
  });
  it("requires the tenant profile email permission as well as outbox consent", async () => {
    await S.sql("UPDATE contacts SET consent_email=false WHERE org_id=$1 AND id=$2", [orgId, tenantId]);
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    expect(p.canSend).toBe(false);
    expect(p.unavailableReason).toContain("contact permission");
    await refused(
      st.accountant.api.property.sendInvoiceEmail({
        params: params(),
        body: { previewKey: p.previewKey, confirm: "SEND" },
      }),
      409,
    );
    await S.sql("UPDATE contacts SET consent_email=true WHERE org_id=$1 AND id=$2", [orgId, tenantId]);
  });
  it("missing email disables confirmation and invalidates an older preview", async () => {
    const old = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    await S.sql("UPDATE contacts SET email=NULL WHERE org_id=$1 AND id=$2", [orgId, tenantId]);
    const p = await st.accountant.api.property.previewInvoiceEmail({ params: params() });
    expect(p.canSend).toBe(false);
    expect(p.unavailableReason).toContain("email address");
    await refused(
      st.accountant.api.property.sendInvoiceEmail({
        params: params(),
        body: { previewKey: old.previewKey, confirm: "SEND" },
      }),
      409,
    );
    await refused(
      st.accountant.api.property.sendInvoiceEmail({
        params: params(),
        body: { previewKey: p.previewKey, confirm: "SEND" },
      }),
      409,
    );
  });
});
