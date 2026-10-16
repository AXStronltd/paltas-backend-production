import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboundMessage } from "../dist/core/notifications/adapters.js";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

describe("signup platform email routing", () => {
  let S: TestServer;
  let a: Account;
  const submitted: OutboundMessage[] = [];
  beforeAll(async () => {
    S = await signupServer({}, { platformEmail: { apiKey: "test-only-not-a-real-key", from: "verify@paltas.io" } });
    S.app.core.notifications.registerAdapter({
      key: "platform_resend",
      channel: "email",
      label: "Test boundary",
      connected: true,
      status: "Test only",
      submit: async (message) => {
        submitted.push(message);
        return { accepted: true, providerMessageId: "receipt-" + message.id, note: "Accepted; delivery not confirmed" };
      },
    });
    a = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  it("dispatches verification independently of the organisation sender and never claims delivery", async () => {
    await a.api.notifications.saveSender({
      params: { orgId: a.orgId, channel: "email" },
      body: { provider: "test", enabled: false },
    });
    expect((await S.app.core.notifications.dispatchPending()).queued).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.to).toBe(a.email);
    expect(submitted[0]?.body).toContain("/verify-email#token=");
    const rows = await S.sql<{ status: string; provider: string; sent_at: string | null }>(
      "SELECT status, provider, sent_at FROM notifications WHERE org_id = $1 AND template_key = 'signup.verify'",
      [a.orgId],
    );
    expect(rows).toEqual([{ status: "queued", provider: "platform_resend", sent_at: null }]);
    await S.app.core.notifications.dispatchPending();
    expect(submitted).toHaveLength(1);
  });

  it("does not let an organisation borrow the platform sender for its own messages", async () => {
    await refused(
      a.api.notifications.saveSender({
        params: { orgId: a.orgId, channel: "email" },
        body: { provider: "platform_resend", enabled: true },
      }),
      403,
    );
    // Even a stale or imported sender row cannot bypass the dispatcher boundary.
    await S.sql(
      "UPDATE notification_senders SET provider = 'platform_resend', enabled = true WHERE org_id = $1 AND channel = 'email'",
      [a.orgId],
    );
    const message = await S.app.core.db.tx((t) =>
      S.app.core.notifications.record(t, {
        orgId: a.orgId,
        channel: "email",
        to: a.email,
        category: "transactional",
        subject: "Customer message",
        body: "Must not use the platform sender",
        source: "manual",
      }),
    );
    await S.app.core.notifications.dispatchPending();
    expect(submitted).toHaveLength(1);
    const rows = await S.sql<{ status: string }>("SELECT status FROM notifications WHERE id = $1", [message.id]);
    expect(rows).toEqual([{ status: "failed" }]);
  });
});
