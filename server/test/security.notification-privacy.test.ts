import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signupServer, signUpAndIn, verificationToken, type Account } from "./support/signup-fixture.js";
import type { TestServer } from "./support/test-server.js";
import { redactSecurityNotification } from "../dist/core/notifications/security-messages.js";

describe("Security emails stay private from organisation history and exports", () => {
  let S: TestServer, a: Account;
  beforeAll(async () => {
    S = await signupServer();
    a = await signUpAndIn(S, "property");
  });
  afterAll(async () => {
    await S?.close();
  });

  async function checkHidden(templateKey: string, token: string) {
    const [message] = await S.sql<{ id: string }>(
      "SELECT id FROM notifications WHERE org_id=$1 AND template_key=$2 ORDER BY created_at DESC LIMIT 1",
      [a.orgId, templateKey],
    );
    // Even an organisation-customised subject/note must not become another route to a security token.
    await S.sql("UPDATE notifications SET subject=$2,status_note=$2 WHERE id=$1", [message!.id, token]);
    await S.sql(
      "INSERT INTO notification_events(notification_id,org_id,provider,provider_event_id,status,detail) VALUES($1,$2,'fixture',$3,'delivered',$4)",
      [message!.id, a.orgId, "privacy-" + message!.id, token],
    );
    const list = await a.api.notifications.listMessages({ params: { orgId: a.orgId } });
    const detail = await a.api.notifications.getMessage({ params: { orgId: a.orgId, messageId: message!.id } });
    expect(JSON.stringify(list).includes(token)).toBe(false);
    expect(JSON.stringify(detail).includes(token)).toBe(false);
    expect(detail.message.body).toMatch(/only shown in the email/);
    const result = await S.raw(
      "GET",
      `/api/v1/orgs/${a.orgId}/export?reason=Security%20message%20privacy%20test`,
      undefined,
      a.token,
    );
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body).includes(token)).toBe(false);
    const raw = await S.sql<{ body: string }>("SELECT body FROM notifications WHERE id=$1", [message!.id]);
    expect(raw[0]!.body.includes(token)).toBe(true);
  }

  it("hides verification links even from the unverified registering administrator", async () => {
    const token = await verificationToken(S, a.email);
    await checkHidden("signup.verify", token);
    expect(await S.api.signup.verify({ body: { token } })).toEqual({ verified: true });
  });
  it("hides password reset links from notification history and full data export", async () => {
    await S.api.identity.requestPasswordReset({ body: { email: a.email } });
    const [message] = await S.sql<{ body: string }>(
      "SELECT body FROM notifications WHERE org_id=$1 AND template_key='password.reset' ORDER BY created_at DESC LIMIT 1",
      [a.orgId],
    );
    const token = /#reset=([A-Za-z0-9_-]+)/.exec(message!.body)?.[1];
    expect(!!token).toBe(true);
    await checkHidden("password.reset", token!);
  });
  it("preserves ordinary notification content", () => {
    const ordinary = {
      template_key: "trial.reminder",
      subject: "Trial reminder",
      body: "Your trial ends soon",
      vars: { days: "10" },
    };
    expect(redactSecurityNotification(ordinary)).toEqual(ordinary);
  });
});
