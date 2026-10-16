// E-mail delivery through real provider adapters, exercised ONLY against LOCAL FAKE servers (test/support/fake-email.ts):
// a fake SMTP server (STARTTLS and implicit TLS, the Gmail-style set-up) and fake Resend / Postmark / SendGrid HTTP
// APIs. Nothing reaches a real provider. Live delivery stays unverified until the owner enters real credentials.
//
// The outbox rules: "sent" only on the provider's acceptance (SMTP: "accepted by mail server", never "delivered");
// "delivered" / "bounced" only from a webhook verified with the provider's own scheme; a temporary failure retries.
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../dist/config.js";
import { emailAdapter } from "../dist/core/notifications/email-providers.js";
import { buildMime, dotStuff, encodeHeader } from "../dist/core/notifications/smtp.js";
import { FAKE_SMTP_CERT, fakeHttpProvider, fakeSmtp, type FakeSmtp } from "./support/fake-email.js";
import { dailyJobs, signUpAndIn, signupServer, verificationToken } from "./support/signup-fixture.js";
import { TODAY, type TestServer } from "./support/test-server.js";

const FROM = "PALTAS <supportpaltas@gmail.com>";
const emailSettings = (env: Record<string, string>): Config["email"] =>
  loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused", PLATFORM_EMAIL_FROM: FROM, ...env }).email;

const smtpEnv = (port: number, secure: boolean, password = "app-password-16ch") => ({
  PLATFORM_EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "localhost",
  SMTP_PORT: String(port),
  SMTP_SECURE: secure ? "true" : "false",
  SMTP_USER: "supportpaltas@gmail.com",
  SMTP_PASSWORD: password,
});

const outbound = (to = "amina@business.test") => ({
  id: "ntf_" + randomBytes(4).toString("hex"),
  orgId: "org_x",
  channel: "email" as const,
  to,
  subject: "Karibu — please confirm your email",
  body: "Hello Amina,\n\nOpen this link:\n\nhttps://paltas.io/verify-email?token=abc\n\n.A line starting with a dot",
  from: { name: "", address: "", replyTo: "" },
});

/** The text part of a message the fake SMTP server received. */
function textPart(data: string): string {
  const m =
    /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(
      data,
    );
  return Buffer.from((m?.[1] ?? "").replace(/\r\n/g, ""), "base64").toString("utf8");
}

describe("SMTP adapter (LOCAL FAKE SMTP server, test certificate)", () => {
  const servers: FakeSmtp[] = [];
  afterAll(async () => Promise.all(servers.map((s) => s.close())));
  const start = async (o: Parameters<typeof fakeSmtp>[0]) => {
    const s = await fakeSmtp(o);
    servers.push(s);
    return s;
  };

  it("STARTTLS path (port 587 style): upgrades before signing in, AUTH PLAIN, MIME text + HTML in UTF-8", async () => {
    const s = await start({ mode: "starttls", user: "supportpaltas@gmail.com", password: "app-password-16ch" });
    const a = emailAdapter({ ...emailSettings(smtpEnv(s.port, false)), provider: "smtp" }, { smtpCa: FAKE_SMTP_CERT });
    expect([a.key, a.connected]).toEqual(["platform_smtp", true]);
    expect(a.status).toMatch(/acceptance only, never delivery/);
    const m = outbound();
    const r = await a.submit(m);
    expect(r).toMatchObject({ accepted: true, sent: true });
    if (!r.accepted) throw new Error("not accepted");
    expect(r.note).toMatch(
      /^Sent \(accepted by mail server localhost: .*OK queued as FAKE1\) — SMTP gives no delivery report/,
    );
    expect(r.providerMessageId).toMatch(new RegExp(`^<${m.id}\\.[0-9a-f]+@gmail\\.com>$`));
    const got = s.messages[0]!;
    expect([got.tls, got.authUser, got.from, got.to]).toEqual([
      true,
      "supportpaltas@gmail.com",
      "supportpaltas@gmail.com",
      ["amina@business.test"],
    ]);
    expect(got.data).toMatch(/^From: "PALTAS" <supportpaltas@gmail\.com>\r\n/m);
    expect(got.data).toMatch(/^Reply-To: <supportpaltas@gmail\.com>\r$/m);
    expect(got.data).toContain(`Subject: ${encodeHeader(m.subject)}`);
    expect(encodeHeader(m.subject)).toMatch(/^=\?UTF-8\?B\?/); // "—" is not ASCII
    expect(got.data).toContain("Content-Type: text/html; charset=UTF-8");
    expect(textPart(got.data)).toBe(m.body);
  });

  it("implicit TLS path (port 465, as smtp.gmail.com:465) with AUTH LOGIN", async () => {
    const s = await start({
      mode: "implicit",
      user: "supportpaltas@gmail.com",
      password: "app-password-16ch",
      mechanisms: ["LOGIN"],
    });
    const a = emailAdapter({ ...emailSettings(smtpEnv(s.port, true)), provider: "smtp" }, { smtpCa: FAKE_SMTP_CERT });
    expect(await a.submit(outbound())).toMatchObject({ accepted: true, sent: true });
    expect(s.messages.map((x) => [x.tls, x.authUser])).toEqual([[true, "supportpaltas@gmail.com"]]);
  });

  it("a wrong password is a final refusal (no retry); an untrusted certificate is refused too", async () => {
    const s = await start({ mode: "implicit", user: "supportpaltas@gmail.com", password: "right" });
    const a = emailAdapter(
      { ...emailSettings(smtpEnv(s.port, true, "wrong")), provider: "smtp" },
      { smtpCa: FAKE_SMTP_CERT },
    );
    const r = await a.submit(outbound());
    expect(r).toEqual({ accepted: false, note: expect.stringMatching(/^SMTP AUTH refused: 535 /) });
    expect([s.authFailures, s.messages.length]).toEqual([1, 0]);
    // without the test CA the fake's self-signed certificate does not verify: nothing is sent, not retried
    const untrusted = emailAdapter({ ...emailSettings(smtpEnv(s.port, true, "right")), provider: "smtp" });
    expect(await untrusted.submit(outbound())).toMatchObject({
      accepted: false,
      note: expect.stringMatching(/connect refused/),
    });
  });

  it("never sends the password in clear: a server without STARTTLS on the submission port is refused", async () => {
    const s = await start({ mode: "starttls", user: "u@x.test", password: "p", noStartTls: true });
    const a = emailAdapter({ ...emailSettings(smtpEnv(s.port, false)), provider: "smtp" }, { smtpCa: FAKE_SMTP_CERT });
    expect(await a.submit(outbound())).toEqual({
      accepted: false,
      note: expect.stringMatching(/does not offer STARTTLS/),
    });
    expect(s.authFailures + s.messages.length).toBe(0);
  });

  it("a temporary failure (451) or an unreachable server is retried; dot-stuffing keeps lines starting with '.'", async () => {
    const s = await start({ mode: "implicit", user: "u@x.test", password: "p", tempFailures: 1 });
    const a = emailAdapter(
      { ...emailSettings({ ...smtpEnv(s.port, true, "p"), SMTP_USER: "u@x.test" }), provider: "smtp" },
      { smtpCa: FAKE_SMTP_CERT },
    );
    expect(await a.submit(outbound())).toEqual({
      accepted: false,
      retry: true,
      note: expect.stringMatching(/^SMTP DATA: 451 .* — will retry$/),
    });
    expect(await a.submit(outbound())).toMatchObject({ accepted: true });
    const closed = emailAdapter({ ...emailSettings(smtpEnv(1, true)), provider: "smtp" }, { smtpCa: FAKE_SMTP_CERT });
    expect(await closed.submit(outbound())).toMatchObject({ accepted: false, retry: true });
    expect(dotStuff("a\r\n.b\r\n..c")).toBe("a\r\n..b\r\n...c");
    expect(
      buildMime(
        { ...outbound(), from: { name: "PALTAS", address: "a@b.test" }, replyTo: "a@b.test", text: "x", ref: "r" },
        "<id@b.test>",
      ),
    ).toMatch(/^MIME-Version: 1\.0\r$/m);
  });
});

describe("the outbox with SMTP configured (LOCAL FAKE SMTP): sign-up verification is really sent", () => {
  let S: TestServer;
  let smtp: FakeSmtp;
  afterAll(async () => {
    await S?.close();
    await smtp?.close();
  });

  it("recorded → (451: stays recorded, retried) → sent (accepted by mail server); never delivered", async () => {
    smtp = await fakeSmtp({
      mode: "implicit",
      user: "supportpaltas@gmail.com",
      password: "app-password-16ch",
      tempFailures: 1,
    });
    S = await signupServer(
      { appBaseUrl: "https://paltas.io" },
      { email: emailSettings(smtpEnv(smtp.port, true)) },
      { smtpCa: FAKE_SMTP_CERT },
    );
    const a = await signUpAndIn(S, "property");
    const N = S.app.core.notifications;
    expect(N.emailDeliveryConfigured()).toBe(true);
    expect(await N.dispatchPending()).toMatchObject({ retrying: 1, sent: 0 });
    let [n] = await S.sql("SELECT * FROM notifications WHERE to_address = lower($1)", [a.email]);
    expect([n.status, n.attempts, n.status_note]).toEqual([
      "recorded",
      1,
      expect.stringMatching(/451 .*attempt 1 of 5/),
    ]);
    expect(await N.dispatchPending()).toMatchObject({ sent: 1 });
    [n] = await S.sql("SELECT * FROM notifications WHERE to_address = lower($1)", [a.email]);
    expect([n.status, n.provider, !!n.sent_at, n.delivered_at]).toEqual(["sent", "platform_smtp", true, null]);
    expect(n.status_note).toMatch(/^Sent \(accepted by mail server localhost/);
    // the e-mail the person gets: warm wording, the link built from APP_BASE_URL, the help address
    const text = textPart(smtp.messages[0]!.data);
    expect(text).toContain(`https://paltas.io/verify-email#token=${await verificationToken(S, a.email)}`);
    expect(text).toMatch(/Welcome to PALTAS!/);
    expect(text).toMatch(/Need help\? Write to us at supportpaltas@gmail\.com\./);
    expect(text).toMatch(/stays valid until \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC/);
    // SMTP has no delivery webhook: nothing can claim "delivered"
    expect((await S.raw("POST", "/api/v1/webhooks/email/smtp", { any: 1 })).status).toBe(400);
  });

  it("with e-mail delivery configured, the policy's default suspends a sign-up left unverified past the window", async () => {
    const late = await signUpAndIn(S, "hotel");
    const r = await dailyJobs(S, "2026-10-19");
    expect(r.summary).toMatch(/[1-9]\d* unverified sign-up\(s\) suspended/);
    const e = await late.api.subscriptions.entitlements({ params: { orgId: late.orgId }, query: {} });
    expect(e.status).toBe("suspended");
    S.setToday(TODAY);
  });
});

describe("HTTP e-mail providers (LOCAL FAKE APIs) and their delivery webhooks", () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  async function serverWith(env: Record<string, string>, answer: Parameters<typeof fakeHttpProvider>[0]) {
    const fake = await fakeHttpProvider(answer);
    const S = await signupServer({}, { email: emailSettings({ ...env, PLATFORM_EMAIL_API_URL: fake.url }) });
    closers.push(() => S.close(), fake.close);
    return { S, fake };
  }

  const svix = (secret: string, id: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({
    "svix-id": id,
    "svix-timestamp": String(ts),
    "svix-signature":
      "v1," +
      createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
        .update(`${id}.${ts}.${body}`)
        .digest("base64"),
  });

  it("Resend: accepted → sent; Svix-signed webhook → delivered, then a late bounce → bounced; bad signatures refused", async () => {
    const secret = "whsec_" + randomBytes(24).toString("base64");
    const { S, fake } = await serverWith(
      { PLATFORM_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key", PLATFORM_EMAIL_WEBHOOK_SECRET: secret },
      () => [200, { id: "re-msg-1" }],
    );
    const a = await signUpAndIn(S, "hotel");
    expect(await S.app.core.notifications.dispatchPending()).toMatchObject({ sent: 1 });
    const req = fake.requests[0]!;
    expect([req.path, req.headers.authorization, req.body.to, req.body.reply_to]).toEqual([
      "/emails",
      "Bearer re_test_key",
      [a.email],
      "supportpaltas@gmail.com",
    ]);
    expect(req.body.from).toBe('"PALTAS" <supportpaltas@gmail.com>');
    expect(req.body.html).toContain("<a href=");
    const hook = (type: string, id: string, headers?: Record<string, string>) => {
      const body = JSON.stringify({ type, data: { email_id: "re-msg-1" } });
      return S.raw("POST", "/api/v1/webhooks/email/resend", body, null, headers ?? svix(secret, id, body));
    };
    expect(
      (
        await hook("email.delivered", "msg_1", {
          "svix-id": "msg_1",
          "svix-timestamp": "1",
          "svix-signature": "v1,AAAA",
        })
      ).status,
    ).toBe(401);
    expect(
      (await hook("email.delivered", "msg_1", svix("whsec_" + randomBytes(24).toString("base64"), "msg_1", "{}")))
        .status,
    ).toBe(401);
    expect((await hook("email.delivered", "msg_1")).body).toEqual({ received: 1, applied: 1 });
    expect((await hook("email.delivered", "msg_1")).body).toEqual({ received: 1, applied: 0 }); // same event again
    let [n] = await S.sql("SELECT status, delivered_at FROM notifications WHERE provider_message_id = 're-msg-1'");
    expect([n.status, !!n.delivered_at]).toEqual(["delivered", true]);
    await hook("email.bounced", "msg_2");
    [n] = await S.sql("SELECT status, bounced_at FROM notifications WHERE provider_message_id = 're-msg-1'");
    expect([n.status, !!n.bounced_at]).toEqual(["bounced", true]);
    // a provider that is not the configured one has no webhook here
    expect((await S.raw("POST", "/api/v1/webhooks/email/postmark", {})).status).toBe(404);
  });

  it("Postmark: an error answer fails the message, a 500 is retried; basic-auth webhook → delivered", async () => {
    const { S } = await serverWith(
      {
        PLATFORM_EMAIL_PROVIDER: "postmark",
        POSTMARK_SERVER_TOKEN: "pm-token",
        PLATFORM_EMAIL_WEBHOOK_SECRET: "hook:s3cret",
      },
      (r, n) =>
        n === 1
          ? [500, { Message: "busy" }]
          : r.body.To.startsWith("bad")
            ? [422, { ErrorCode: 406, Message: "Inactive recipient" }]
            : [200, { ErrorCode: 0, MessageID: "pm-" + n }],
    );
    const good = await signUpAndIn(S, "security");
    expect(await S.app.core.notifications.dispatchPending()).toMatchObject({ retrying: 1 });
    expect(await S.app.core.notifications.dispatchPending()).toMatchObject({ sent: 1 });
    await signUpAndIn(S, "agency", { email: "bad+" + randomBytes(3).toString("hex") + "@business.test" });
    expect(await S.app.core.notifications.dispatchPending()).toMatchObject({ failed: 1 });
    const [sent] = await S.sql("SELECT provider_message_id FROM notifications WHERE to_address = lower($1)", [
      good.email,
    ]);
    const body = { RecordType: "Delivery", MessageID: sent.provider_message_id, DeliveredAt: "2026-10-11T08:00:00Z" };
    const auth = (cred: string) => ({ Authorization: "Basic " + Buffer.from(cred).toString("base64") });
    expect((await S.raw("POST", "/api/v1/webhooks/email/postmark", body, null, auth("hook:wrong"))).status).toBe(401);
    expect((await S.raw("POST", "/api/v1/webhooks/email/postmark", body, null, auth("hook:s3cret"))).body).toEqual({
      received: 1,
      applied: 1,
    });
    const [n] = await S.sql("SELECT status FROM notifications WHERE to_address = lower($1)", [good.email]);
    expect(n.status).toBe("delivered");
    const [failed] = await S.sql("SELECT status, status_note FROM notifications WHERE to_address LIKE 'bad+%'");
    expect([failed.status, failed.status_note]).toEqual(["failed", expect.stringMatching(/422 Inactive recipient/)]);
  });

  it("SendGrid: 202 + X-Message-Id → sent; ECDSA-signed event webhook → delivered", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const { S } = await serverWith(
      { PLATFORM_EMAIL_PROVIDER: "sendgrid", SENDGRID_API_KEY: "SG.key", PLATFORM_EMAIL_WEBHOOK_SECRET: pub },
      () => [202, {}, { "X-Message-Id": "sg-abc" }],
    );
    await signUpAndIn(S, "developer");
    expect(await S.app.core.notifications.dispatchPending()).toMatchObject({ sent: 1 });
    const body = JSON.stringify([{ event: "delivered", sg_message_id: "sg-abc.filter001", sg_event_id: "ev-1" }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(ts + body), privateKey).toString("base64");
    const headers = {
      "X-Twilio-Email-Event-Webhook-Signature": sig,
      "X-Twilio-Email-Event-Webhook-Timestamp": ts,
    };
    expect(
      (await S.raw("POST", "/api/v1/webhooks/email/sendgrid", body.replace("delivered", "bounce"), null, headers))
        .status,
    ).toBe(401);
    expect((await S.raw("POST", "/api/v1/webhooks/email/sendgrid", body, null, headers)).body).toEqual({
      received: 1,
      applied: 1,
    });
    const [n] = await S.sql("SELECT status FROM notifications WHERE provider_message_id = 'sg-abc'");
    expect(n.status).toBe("delivered");
  });
});

describe("without a provider (or without its credentials) nothing changes: recorded, never sent", () => {
  let S: TestServer;
  afterAll(() => S?.close());

  it("PLATFORM_EMAIL_PROVIDER=smtp without SMTP_PASSWORD: not in use, the server starts, messages go to the test adapter", async () => {
    const email = emailSettings({
      PLATFORM_EMAIL_PROVIDER: "smtp",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_USER: "supportpaltas@gmail.com",
    });
    expect([email.provider, email.notConfigured]).toEqual([
      null,
      "PLATFORM_EMAIL_PROVIDER=smtp needs SMTP_HOST, SMTP_USER and SMTP_PASSWORD",
    ]);
    S = await signupServer({}, { email });
    const a = await signUpAndIn(S, "property");
    expect(S.app.core.notifications.emailDeliveryConfigured()).toBe(false);
    await S.app.core.notifications.dispatchPending();
    const [n] = await S.sql("SELECT status, provider, status_note FROM notifications WHERE to_address = lower($1)", [
      a.email,
    ]);
    expect(n).toEqual({
      status: "queued",
      provider: "test",
      status_note: expect.stringMatching(/Not connected — test adapter/),
    });
  });
});
