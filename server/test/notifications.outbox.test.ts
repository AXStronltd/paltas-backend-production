// The notifications outbox: templates and sender settings per organisation, consent rules, the status lifecycle
// (recorded → queued → sent / failed ONLY by a provider's signed report), test adapters that never "send", roles,
// organisation isolation, and the scheduled dispatch.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NotificationAdapter } from "../dist/core/notifications/adapters.js";
import { signedPost } from "./support/platform-fixtures.js";
import { refused, startServer, WEBHOOK_SECRET, type Person, type TestServer } from "./support/test-server.js";

const MAIL_SECRET = "whsec_mail_" + randomBytes(12).toString("hex");

/**
 * TEST-ONLY stand-in for a connected e-mail provider: it returns a provider message id, like a real adapter would,
 * so the delivery-report path can be exercised. Nothing is sent anywhere. Never registered outside this test.
 */
function standInMailProvider(): NotificationAdapter & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    key: "fakemail",
    channel: "email",
    label: "Stand-in e-mail provider (test only)",
    connected: true,
    status: "Connected (test stand-in)",
    submitted,
    submit: async (m) => {
      submitted.push(m.id);
      return { accepted: true, providerMessageId: "fm-" + m.id, note: "Accepted by the stand-in provider" };
    },
  };
}

describe("notifications outbox", () => {
  let S: TestServer;
  let orgId: string;
  let admin: Person;
  const mail = standInMailProvider();

  beforeAll(async () => {
    S = await startServer({ config: { webhookSecrets: { testpay: WEBHOOK_SECRET, fakemail: MAIL_SECRET } } });
    const o = await S.newOrg({ name: "Almas Tower Management" });
    orgId = o.orgId;
    admin = o.admin;
  });
  afterAll(() => S.close());

  const N = () => admin.api.notifications;
  const P = () => ({ orgId });
  const record: ReturnType<typeof N>["recordMessage"] = (input) => N().recordMessage(input);

  it("lists the providers honestly: test adapters only, every live provider BLOCKED", async () => {
    const { providers } = await N().providers({ params: P() });
    expect(providers.filter((p) => p.key === "test").map((p) => [p.channel, p.status, p.connected])).toEqual([
      ["email", "Not connected — test adapter", false],
      ["sms", "Not connected — test adapter", false],
      ["whatsapp", "Not connected — test adapter", false],
      ["push", "Not connected — test adapter", false],
    ]);
    const live = providers.filter((p) => p.key !== "test");
    expect(live.map((p) => p.key).sort()).toEqual(["email_api", "push_fcm", "sms_api", "smtp", "whatsapp_cloud"]);
    expect(live.every((p) => !p.connected && p.status.startsWith("BLOCKED"))).toBe(true);
  });

  it("sender settings: defaults to the test adapter; a provider that is not connected cannot be chosen", async () => {
    const { senders } = await N().listSenders({ params: P() });
    expect(senders.map((s) => [s.channel, s.provider, s.providerStatus])).toEqual([
      ["email", "test", "Not connected — test adapter"],
      ["sms", "test", "Not connected — test adapter"],
      ["whatsapp", "test", "Not connected — test adapter"],
      ["push", "test", "Not connected — test adapter"],
    ]);
    const r = await refused(
      N().saveSender({ params: { ...P(), channel: "email" }, body: { provider: "smtp", fromName: "Almas" } }),
      409,
    );
    expect(r.message).toMatch(/not connected: BLOCKED/);
    await refused(N().saveSender({ params: { ...P(), channel: "sms" }, body: { provider: "smtp" } }), 400);
    const saved = await N().saveSender({
      params: { ...P(), channel: "email" },
      body: {
        provider: "test",
        fromName: "Almas Tower",
        fromAddress: "notices@almas.example",
        replyTo: "desk@almas.example",
      },
    });
    expect([saved.provider, saved.fromName]).toEqual(["test", "Almas Tower"]);
  });

  it("templates: PALTAS defaults until the organisation saves its own wording; every placeholder needs a value", async () => {
    let { templates } = await N().listTemplates({ params: P() });
    const email = templates.find((t) => t.key === "generic.notice" && t.channel === "email")!;
    expect([email.source, email.variables]).toEqual(["paltas", ["message", "name", "orgName", "subject"]]);
    await N().saveTemplate({
      params: { ...P(), key: "rent.reminder", channel: "email" },
      body: {
        subject: "Rent due {{dueDate}}",
        body: "Dear {{name}}, rent of {{amount}} is due on {{dueDate}}. — {{orgName}}",
      },
    });
    templates = (await N().listTemplates({ params: P() })).templates;
    expect(templates.find((t) => t.key === "rent.reminder")).toMatchObject({
      source: "organisation",
      variables: ["amount", "dueDate", "name", "orgName"],
    });
    const missing = await refused(
      record({
        params: P(),
        body: {
          channel: "email",
          to: "tenant@example.com",
          category: "transactional",
          templateKey: "rent.reminder",
          vars: { name: "Amina" },
        },
      }),
      400,
    );
    expect(missing.details).toEqual({ missing: ["amount", "dueDate"] });
    const m = await record({
      params: P(),
      body: {
        channel: "email",
        to: " Tenant@Example.com ",
        category: "transactional",
        templateKey: "rent.reminder",
        vars: { name: "Amina", amount: "KES 45,000", dueDate: "2026-11-01" },
        ref: "reminder-A1-2026-11",
      },
    });
    expect([m.status, m.to, m.subject]).toEqual(["recorded", "tenant@example.com", "Rent due 2026-11-01"]);
    expect(m.body).toBe("Dear Amina, rent of KES 45,000 is due on 2026-11-01. — Almas Tower Management");
    // the same ref is recorded once
    const again = await record({
      params: P(),
      body: {
        channel: "email",
        to: "tenant@example.com",
        category: "transactional",
        templateKey: "rent.reminder",
        vars: { name: "Amina", amount: "KES 45,000", dueDate: "2026-11-01" },
        ref: "reminder-A1-2026-11",
      },
    });
    expect(again.id).toBe(m.id);
    await refused(
      record({
        params: P(),
        body: { channel: "sms", to: "0712 345", category: "transactional", templateKey: "generic.notice", vars: {} },
      }),
      400,
    );
  });

  it("consent: WhatsApp and marketing need an opt-in; an opt-out stops transactional messages; history is kept", async () => {
    const notice = {
      templateKey: "generic.notice",
      vars: { name: "Amina", message: "Water off 10:00–12:00", subject: "Water" },
    };
    const wa = await record({
      params: P(),
      body: { channel: "whatsapp", to: "+254 712 345 678", category: "transactional", ...notice },
    });
    expect([wa.status, wa.statusNote]).toEqual([
      "suppressed",
      "Suppressed — no WhatsApp opt-in recorded for this address",
    ]);
    await N().recordConsent({
      params: P(),
      body: {
        channel: "whatsapp",
        address: "+254712345678",
        purpose: "transactional",
        granted: true,
        source: "Signed lease form A1",
      },
    });
    const wa2 = await record({
      params: P(),
      body: { channel: "whatsapp", to: "+254712345678", category: "transactional", ...notice },
    });
    expect(wa2.status).toBe("recorded");

    const mk = await record({
      params: P(),
      body: { channel: "email", to: "lead@example.com", category: "marketing", ...notice },
    });
    expect(mk.status).toBe("suppressed");
    await N().recordConsent({
      params: P(),
      body: {
        channel: "sms",
        address: "+254700000001",
        purpose: "transactional",
        granted: false,
        source: "Replied STOP",
      },
    });
    const sms = await record({
      params: P(),
      body: { channel: "sms", to: "+254700000001", category: "transactional", ...notice },
    });
    expect([sms.status, sms.statusNote]).toEqual(["suppressed", "Suppressed — the person opted out of sms messages"]);
    const { consents } = await N().listConsents({ params: P(), query: { address: "+254 712 345 678" } });
    expect(consents.map((c) => [c.channel, c.granted, c.source])).toEqual([["whatsapp", true, "Signed lease form A1"]]);
    // consent history cannot be rewritten
    await expect(
      S.sql("UPDATE notification_consents SET granted = true WHERE address = '+254700000001'"),
    ).rejects.toThrow(/cannot be changed/);
  });

  it("dispatch hands recorded messages to the test adapter: queued, labelled, never sent", async () => {
    const before = await N().listMessages({ params: P(), query: { status: "recorded" } });
    expect(before.messages.length).toBeGreaterThanOrEqual(2);
    const c = await S.app.core.notifications.dispatchPending();
    expect(c.queued).toBe(before.messages.length);
    const queued = await N().listMessages({ params: P(), query: { status: "queued" } });
    expect(queued.messages.length).toBe(before.messages.length);
    for (const m of queued.messages) {
      expect([m.provider, m.providerMessageId]).toEqual(["test", null]);
      expect(m.statusNote).toMatch(/^Not connected — test adapter: queued in PALTAS only — nothing was sent$/);
    }
    // suppressed messages are never handed on
    expect((await N().listMessages({ params: P(), query: { status: "suppressed" } })).messages.length).toBe(3);
    expect((await N().listMessages({ params: P(), query: { status: "sent" } })).messages).toEqual([]);
    // the database itself refuses "sent" for a test-adapter message
    await expect(
      S.sql("UPDATE notifications SET status = 'sent' WHERE id = $1", [queued.messages[0]!.id]),
    ).rejects.toThrow(/notification_sent_needs_provider/);
  });

  it("only a provider's signed delivery report makes a message sent or failed", async () => {
    S.app.core.notifications.registerAdapter(mail);
    await N().saveSender({
      params: { ...P(), channel: "email" },
      body: { provider: "fakemail", fromName: "Almas Tower" },
    });
    const m = await record({
      params: P(),
      body: {
        channel: "email",
        to: "owner@example.com",
        category: "transactional",
        templateKey: "generic.notice",
        vars: { name: "Owner", message: "Statement ready", subject: "Statement" },
      },
    });
    await S.app.core.notifications.dispatchPending();
    let got = await N().getMessage({ params: { ...P(), messageId: m.id } });
    expect([got.message.status, got.message.provider, got.message.providerMessageId]).toEqual([
      "queued",
      "fakemail",
      "fm-" + m.id,
    ]);
    expect(mail.submitted).toEqual([m.id]);

    const report = { id: "evt-1", messageId: "fm-" + m.id, status: "delivered", detail: "250 OK" };
    // unsigned or wrongly signed: refused, nothing changes
    expect((await S.raw("POST", "/api/v1/webhooks/notifications/fakemail", report)).status).toBe(401);
    expect((await signedPost(S, "/api/v1/webhooks/notifications/fakemail", report, "wrong-secret")).status).toBe(401);
    // an unknown provider has no secret
    expect((await signedPost(S, "/api/v1/webhooks/notifications/nosuch", report, MAIL_SECRET)).status).toBe(404);
    const ok = await signedPost(S, "/api/v1/webhooks/notifications/fakemail", report, MAIL_SECRET);
    expect([ok.status, ok.body]).toEqual([200, { duplicate: false, messageId: m.id, status: "delivered" }]);
    const dup = await signedPost(S, "/api/v1/webhooks/notifications/fakemail", report, MAIL_SECRET);
    expect(dup.body.duplicate).toBe(true);
    // a later bounce turns it to bounced
    await signedPost(
      S,
      "/api/v1/webhooks/notifications/fakemail",
      { id: "evt-2", messageId: "fm-" + m.id, status: "failed", detail: "Mailbox full" },
      MAIL_SECRET,
    );
    got = await N().getMessage({ params: { ...P(), messageId: m.id } });
    expect([got.message.status, got.message.statusNote, !!got.message.bouncedAt]).toEqual([
      "bounced",
      "failed: Mailbox full — reported by fakemail",
      true,
    ]);
    expect(got.events.map((e) => [e.providerEventId, e.status])).toEqual([
      ["evt-1", "delivered"],
      ["evt-2", "failed"],
    ]);
    // a report for a message of another provider is not found
    const testMsg = (await N().listMessages({ params: P(), query: { status: "queued" } })).messages.find(
      (x) => x.provider === "test",
    )!;
    expect(
      (
        await signedPost(
          S,
          "/api/v1/webhooks/notifications/fakemail",
          { id: "evt-3", messageId: testMsg.id, status: "sent" },
          MAIL_SECRET,
        )
      ).status,
    ).toBe(404);
    await N().saveSender({ params: { ...P(), channel: "email" }, body: { provider: "test" } });
  });

  it("a turned-off sender keeps messages waiting; products record through the core service, idempotently", async () => {
    await N().saveSender({ params: { ...P(), channel: "sms" }, body: { provider: "test", enabled: false } });
    const first = await S.app.core.db.tx((t) =>
      S.app.core.notifications.record(t, {
        orgId,
        channel: "sms",
        to: "+254711000111",
        category: "transactional",
        templateKey: "generic.notice",
        vars: { name: "Guest", message: "Your room is ready", subject: "" },
        source: "hotel",
        sourceRef: "room-ready-R1",
      }),
    );
    const second = await S.app.core.db.tx((t) =>
      S.app.core.notifications.record(t, {
        orgId,
        channel: "sms",
        to: "+254711000111",
        category: "transactional",
        body: "different text, same ref",
        source: "hotel",
        sourceRef: "room-ready-R1",
      }),
    );
    expect(second.id).toBe(first.id);
    const c = await S.app.core.notifications.dispatchPending();
    expect(c.waiting).toBe(1);
    const got = await N().getMessage({ params: { ...P(), messageId: first.id } });
    expect([got.message.status, got.message.statusNote]).toEqual([
      "recorded",
      "Waiting — the organisation turned this channel's sender off",
    ]);
  });

  it("the scheduler's dispatch job does the same, on its schedule", async () => {
    await N().saveSender({ params: { ...P(), channel: "sms" }, body: { provider: "test", enabled: true } });
    const sa = await S.staff();
    const job = (await sa.api.ops.listJobs({ query: { key: "platform.notifications.dispatch" } })).jobs[0]!;
    // only the run asked for here (not the every-minute schedule) should do the work
    await sa.api.ops.pauseJob({ params: { jobId: job.id }, body: { reason: "Hold the schedule during the test" } });
    await sa.api.ops.runJobNow({ params: { jobId: job.id }, body: { reason: "Dispatch now (test)" } });
    for (let i = 0; i < 5 && (await S.app.core.schedulerWorker.runOnce()); i++);
    const runs = await sa.api.ops.listRuns({ params: { jobId: job.id } });
    expect(runs.runs.find((r) => r.trigger === "manual")?.summary).toMatch(
      /^0 sent \(accepted by the provider\) · 1 queued \(test adapter, not sent\) · 0 refused · 0 to retry · 0 waiting$/,
    );
  });

  it("roles and isolation: readers cannot change anything, others' messages look like nothing", async () => {
    const auditor = await S.addMember(orgId, admin.api, "auditor");
    expect((await auditor.api.notifications.listMessages({ params: P() })).messages.length).toBeGreaterThan(0);
    await refused(
      auditor.api.notifications.recordConsent({
        params: P(),
        body: { channel: "email", address: "x@example.com", purpose: "marketing", granted: true, source: "Form" },
      }),
      403,
      "ROLE_NOT_ALLOWED",
    );
    const viewer = await S.addMember(orgId, admin.api, "viewer");
    await refused(viewer.api.notifications.listMessages({ params: P() }), 403, "ROLE_NOT_ALLOWED");
    const other = await S.newOrg({ name: "Other Estates" });
    const mine = (await N().listMessages({ params: P() })).messages[0]!;
    await refused(
      other.admin.api.notifications.getMessage({ params: { orgId: other.orgId, messageId: mine.id } }),
      404,
    );
    await refused(other.admin.api.notifications.listMessages({ params: P() }), 404);
    expect((await other.admin.api.notifications.listMessages({ params: { orgId: other.orgId } })).messages).toEqual([]);
    // settings changes are audited
    const audit = await admin.api.organisations.listAudit({ params: P(), query: { limit: 100 } });
    expect(audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "Notification sender changed",
        "Notification template saved",
        "Consent given",
        "Consent withdrawn",
        "Message recorded",
      ]),
    );
  });
});
