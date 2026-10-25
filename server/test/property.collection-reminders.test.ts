// Every provider endpoint in this test is a localhost fake. No customer emails are sent.
import { beforeAll, afterAll, it, expect } from "vitest";
import { loadConfig } from "../dist/config.js";
import { fakeHttpProvider } from "./support/fake-email.js";
import { startPropertyServer, pmOrg, setUpBuilding, newTenant } from "./support/property-fixture.js";
import { refused, type TestServer, type Person } from "./support/test-server.js";
import {
  collectionRemindersService,
  DEFAULT_REMINDERS,
} from "../dist/products/property/billing/collection-reminders.service.js";
import { pmAccess } from "../dist/products/property/shared/access.js";
import type { property as P } from "@paltas/contracts";
let S: TestServer,
  fake: Awaited<ReturnType<typeof fakeHttpProvider>>,
  admin: Person,
  orgId: string,
  propertyId: string,
  tenantId: string,
  invoiceId: string,
  policy: P.ReminderPolicy,
  manager: Person;
const params = () => ({ orgId, propertyId });
beforeAll(async () => {
  let sent = 0;
  fake = await fakeHttpProvider(() => [200, { id: "local-reminder-email-" + ++sent }]);
  const email = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    PLATFORM_EMAIL_PROVIDER: "resend",
    PLATFORM_EMAIL_FROM: "PALTAS <billing@paltas.test>",
    RESEND_API_KEY: "re_test_only",
    PLATFORM_EMAIL_API_URL: fake.url,
  }).email;
  S = await startPropertyServer({ email });
  S.setToday("2026-10-11");
  const o = await pmOrg(S);
  ({ orgId, admin } = o);
  const b = await setUpBuilding(orgId, admin);
  propertyId = b.propertyId;
  tenantId = await newTenant(admin, orgId, "Reminder Tenant");
  await admin.api.contacts.updateContact({
    params: { orgId, contactId: tenantId },
    body: { email: "resident@reminder.test", consent: { email: true, source: "Tenant test permission" } },
  });
  const l = await admin.api.property.createLease({
    params: { orgId },
    body: { unitId: b.units["A-101"]!, tenantId, startDate: "2026-10-01", rentMinor: 100000 },
  });
  const a = await admin.api.property.activateLease({
    params: { orgId, leaseId: l.id },
    body: { signedOn: "2026-10-01", billFirstRent: true },
  });
  invoiceId = a.firstRentInvoice!.id;
});
afterAll(async () => {
  await S?.close();
  await fake?.close();
});
it("defaults automation off, previews the real debt and rejects stale confirmations without recording a message", async () => {
  policy = await admin.api.property.getReminderPolicy({ params: params() });
  expect(policy.version).toBe(0);
  expect(policy.input.enabled).toBe(false);
  expect(policy.emailConfigured).toBe(true);
  let p = await admin.api.property.previewCollectionReminders({ params: params() });
  expect(p.candidates[0]).toMatchObject({ balanceMinor: 100000, canSend: true, stageDays: 3 });
  expect(p.candidates[0]?.body).toContain("KES 1,000.00");
  await admin.api.property.recordPayment({
    params: { orgId },
    body: { tenantId, date: "2026-10-11", amountMinor: 1000, method: "cash", reference: "PARTIAL-REMINDER" },
  });
  await refused(
    admin.api.property.sendCollectionReminders({
      params: params(),
      body: { items: [{ invoiceId, previewKey: p.candidates[0]!.previewKey }], confirm: "SEND_REMINDERS" },
    }),
    409,
  );
  expect((await admin.api.property.collectionReminderHistory({ params: params() })).total).toBe(0);
  p = await admin.api.property.previewCollectionReminders({ params: params() });
  expect(p.candidates[0]?.balanceMinor).toBe(99000);
});
it("confirms a reviewed bulk reminder once, shows actual provider status and leaves the ledger unchanged", async () => {
  const p = await admin.api.property.previewCollectionReminders({ params: params() }),
    c = p.candidates[0]!;
  const before = (await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n;
  const r = await admin.api.property.sendCollectionReminders({
    params: params(),
    body: { items: [{ invoiceId, previewKey: c.previewKey }], confirm: "SEND_REMINDERS" },
  });
  expect(r.recorded).toBe(1);
  let h = await admin.api.property.collectionReminderHistory({ params: params() });
  expect(h.reminders[0]?.status).toBe("recorded");
  await refused(
    admin.api.property.sendCollectionReminders({
      params: params(),
      body: { items: [{ invoiceId, previewKey: c.previewKey }], confirm: "SEND_REMINDERS" },
    }),
    409,
  );
  await S.app.core.notifications.dispatchPending();
  h = await admin.api.property.collectionReminderHistory({ params: params() });
  expect(h.reminders[0]?.status).toBe("sent");
  expect(h.reminders[0]?.status).not.toBe("delivered");
  expect(fake.requests).toHaveLength(1);
  expect((await S.sql("SELECT count(*)::int n FROM journal_entries WHERE org_id=$1", [orgId]))[0].n).toBe(before);
  await expect(S.sql("DELETE FROM pm_collection_reminders WHERE org_id=$1", [orgId])).rejects.toThrow();
});
it("saves explicit automation with optimistic versions and rejects unknown template fields", async () => {
  await refused(
    admin.api.property.saveReminderPolicy({
      params: params(),
      body: {
        expectedVersion: 0,
        input: { ...DEFAULT_REMINDERS, body: "Unknown {{bankPassword}} field in a template" },
        reason: "Invalid template test",
        confirm: "SAVE_REMINDERS",
      },
    }),
    400,
  );
  policy = await admin.api.property.saveReminderPolicy({
    params: params(),
    body: {
      expectedVersion: 0,
      input: { ...DEFAULT_REMINDERS, enabled: true },
      reason: "Reviewed company reminder policy",
      confirm: "SAVE_REMINDERS",
    },
  });
  expect(policy.version).toBe(1);
  await refused(
    admin.api.property.saveReminderPolicy({
      params: params(),
      body: { expectedVersion: 0, input: policy.input, reason: "Stale policy attempt", confirm: "SAVE_REMINDERS" },
    }),
    409,
  );
  const jobs = await S.sql(
    "SELECT key,timezone FROM sched_jobs WHERE org_id=$1 AND target_id=$2 AND key='property.collection_reminders'",
    [orgId, propertyId],
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0].timezone).toBe("Africa/Nairobi");
});
it("skips disputed debt and approved plans; catches up to only the latest reminder stage", async () => {
  S.setToday("2026-10-20");
  const d = await admin.api.property.createBillingDispute({
    params: { orgId },
    body: { invoiceId, amountMinor: 1000, reason: "Review this service allocation" },
  });
  let p = await admin.api.property.previewCollectionReminders({ params: params() });
  expect(p.candidates[0]?.reason).toContain("billing query");
  const service = collectionRemindersService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
  expect((await service.automatic(orgId, propertyId, "2026-10-20")).summary).toContain("0 reminder(s)");
  await admin.api.property.billingDisputeAction({
    params: { orgId, disputeId: d.id },
    body: { expectedVersion: d.version, action: "resolve", reason: "Explanation reviewed; amount remains due" },
  });
  let plan = await admin.api.property.createCollectionPlan({
    params: { orgId },
    body: {
      invoiceId,
      kind: "promise",
      schedule: [{ dueDate: "2026-11-01", amountMinor: 99000 }],
      evidenceRef: "Confirmed promise to pay",
    },
  });
  plan = await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "approve", reason: "Company approved repayment promise" },
  });
  p = await admin.api.property.previewCollectionReminders({ params: params() });
  expect(p.candidates[0]?.reason).toContain("payment arrangement");
  await admin.api.property.collectionPlanAction({
    params: { orgId, planId: plan.id },
    body: { expectedVersion: plan.version, action: "cancel", reason: "Promise withdrawn by mutual request" },
  });
  expect((await service.automatic(orgId, propertyId, "2026-10-20")).summary).toContain("1 reminder(s)");
  expect((await service.automatic(orgId, propertyId, "2026-10-20")).summary).toContain("0 reminder(s)");
  const h = await admin.api.property.collectionReminderHistory({ params: params() });
  expect(h.total).toBe(2);
  expect(h.reminders[0]?.stageDays).toBe(14);
});
it("honours transactional opt-out and reports suppression instead of delivery", async () => {
  S.setToday("2026-10-25");
  policy = await admin.api.property.saveReminderPolicy({
    params: params(),
    body: {
      expectedVersion: policy.version,
      input: { ...policy.input, daysAfterDue: [0, 3, 7, 14, 20] },
      reason: "Add final reviewed reminder date",
      confirm: "SAVE_REMINDERS",
    },
  });
  await S.sql(
    "INSERT INTO notification_consents(org_id,channel,address,purpose,granted,source) VALUES($1,'email','resident@reminder.test','transactional',false,'Local test')",
    [orgId],
  );
  const p = await admin.api.property.previewCollectionReminders({ params: params() });
  await admin.api.property.sendCollectionReminders({
    params: params(),
    body: { items: [{ invoiceId, previewKey: p.candidates[0]!.previewKey }], confirm: "SEND_REMINDERS" },
  });
  const h = await admin.api.property.collectionReminderHistory({ params: params() });
  expect(h.reminders[0]?.status).toBe("suppressed");
  await S.app.core.notifications.dispatchPending();
  expect(fake.requests).toHaveLength(2);
});
it("restricts property access and stops automated reminders after manager authorisation is revoked", async () => {
  manager = await S.addMember(orgId, admin.api, "main_manager");
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: {
      grants: [
        { product: "property", capabilities: ["property.billing", "property.read"], propertyIds: [], enabled: true },
      ],
      reason: "No properties assigned yet",
      confirm: "SAVE_PERMISSIONS",
    },
  });
  await refused(manager.api.property.getReminderPolicy({ params: params() }), 404);
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: {
      grants: [
        {
          product: "property",
          capabilities: ["property.billing", "property.read"],
          propertyIds: [propertyId],
          enabled: true,
        },
      ],
      reason: "Assigned reminder operations",
      confirm: "SAVE_PERMISSIONS",
    },
  });
  policy = await manager.api.property.saveReminderPolicy({
    params: params(),
    body: {
      expectedVersion: policy.version,
      input: policy.input,
      reason: "Reviewed manager policy",
      confirm: "SAVE_REMINDERS",
    },
  });
  await admin.api.organisations.setManagerGrants({
    params: { orgId, userId: manager.userId },
    body: { grants: [], reason: "Manager authority revoked", confirm: "SAVE_PERMISSIONS" },
  });
  const service = collectionRemindersService({ ctx: S.app.ctx, core: S.app.core, access: pmAccess(S.app.core) });
  expect((await service.automatic(orgId, propertyId, "2026-11-01")).summary).toContain(
    "authorisation is no longer active",
  );
  await S.sql("UPDATE sched_jobs SET status='paused',paused_reason='reminder test' WHERE org_id IS NULL");
  const [job] = await S.sql(
    "SELECT id,next_run_at FROM sched_jobs WHERE org_id=$1 AND target_id=$2 AND key='property.collection_reminders'",
    [orgId, propertyId],
  );
  const at = new Date(new Date(job.next_run_at).getTime() + 60000);
  expect(await S.app.core.scheduler.runOnce("reminder-test", at)).toBe(true);
  const [run] = await S.sql("SELECT status,summary FROM sched_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1", [
    job.id,
  ]);
  expect(run.status).toBe("succeeded");
  expect(run.summary).toContain("authorisation is no longer active");
  const foreign = await pmOrg(S);
  await refused(foreign.admin.api.property.collectionReminderHistory({ params: params() }), 404);
});

it("serialises concurrent confirmations and validates essential financial context in templates", async () => {
  await refused(
    admin.api.property.saveReminderPolicy({
      params: params(),
      body: {
        expectedVersion: policy.version,
        input: { ...policy.input, body: "A reminder without the essential financial fields" },
        reason: "Missing fields are unsafe",
        confirm: "SAVE_REMINDERS",
      },
    }),
    400,
  );
  S.setToday("2026-10-26");
  policy = await admin.api.property.saveReminderPolicy({
    params: params(),
    body: {
      expectedVersion: policy.version,
      input: { ...policy.input, enabled: false, daysAfterDue: [21] },
      reason: "Reviewed manual next-stage reminder",
      confirm: "SAVE_REMINDERS",
    },
  });
  const c = (await admin.api.property.previewCollectionReminders({ params: params() })).candidates[0]!;
  const args = {
    params: params(),
    body: { items: [{ invoiceId, previewKey: c.previewKey }], confirm: "SEND_REMINDERS" as const },
  };
  const results = await Promise.allSettled([
    admin.api.property.sendCollectionReminders(args),
    admin.api.property.sendCollectionReminders(args),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
  const rows = await S.sql(
    "SELECT id FROM pm_collection_reminders WHERE org_id=$1 AND invoice_id=$2 AND stage_days=21",
    [orgId, invoiceId],
  );
  expect(rows).toHaveLength(1);
  const d = await admin.api.property.dashboard({ params: { orgId } });
  expect(Object.values(d.ledger).every((x) => x.agrees)).toBe(true);
});
