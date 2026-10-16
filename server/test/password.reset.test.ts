// Self-service password reset: a generic answer that never reveals whether an address has an account, a hashed
// single-use short-lived token sent through the e-mail outbox, rate limits, and on use: new password, every session
// signed out, audited.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULTS } from "./support/platform-fixtures.js";
import { signUpAndIn, signupServer, type Account } from "./support/signup-fixture.js";
import { refused, type TestServer } from "./support/test-server.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("self-service password reset", () => {
  let S: TestServer;
  let a: Account;

  beforeAll(async () => {
    S = await signupServer(
      { appBaseUrl: "https://paltas.io" },
      { passwordReset: { ...DEFAULTS.passwordReset, perIpPerHour: 12 } },
    );
    a = await signUpAndIn(S, "property");
  });
  afterAll(() => S.close());

  const request = (email: string) => S.raw("POST", "/api/v1/public/password-reset", { email });
  async function latestToken(email: string) {
    const [n] = await S.sql<{ body: string; status: string; source: string }>(
      `SELECT body, status, source FROM notifications WHERE template_key = 'password.reset' AND to_address = lower($1)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [email],
    );
    const m = /account\.html#reset=([A-Za-z0-9_-]+)/.exec(n?.body ?? "");
    return { token: m?.[1] ?? "", message: n };
  }

  it("answers the same for an unknown address, a staff account and a real one; only the real one gets a link", async () => {
    const unknown = await request("nobody@nowhere.test");
    const staff = await S.staff();
    const [sa] = await S.sql<{ email: string }>("SELECT email FROM users WHERE id = $1", [staff.userId]);
    const staffAnswer = await request(sa!.email);
    const real = await request(a.email);
    expect(unknown).toEqual(real);
    expect(staffAnswer).toEqual(real);
    expect(real.status).toBe(200);
    expect(real.body.message).toMatch(/If this e-mail address has a PALTAS account/);
    expect(
      await S.sql("SELECT 1 FROM notifications WHERE template_key = 'password.reset' AND to_address <> lower($1)", [
        a.email,
      ]),
    ).toEqual([]);
    const { token, message } = await latestToken(a.email);
    expect(token.length).toBeGreaterThan(20);
    // recorded in the outbox (no provider here: recorded, never claimed as sent); warm wording with the help address
    expect([message!.status, message!.source]).toEqual(["recorded", "platform"]);
    expect(message!.body).toMatch(/valid for 30 minutes/);
    expect(message!.body).toContain("Need help? Write to us at supportpaltas@gmail.com.");
    // only the hash is stored
    const rows = await S.sql<{ token_hash: string }>("SELECT token_hash FROM password_resets");
    expect(rows.map((r) => r.token_hash)).toEqual([sha256(token)]);
    expect(JSON.stringify(await S.sql("SELECT * FROM password_resets"))).not.toContain(token);
  });

  it("the link works once, signs out every session, clears a lock-out, and is audited", async () => {
    const other = await S.login(a.email, a.password); // a second device
    await S.sql("UPDATE users SET failed_count = 3 WHERE lower(email) = lower($1)", [a.email]);
    const { token } = await latestToken(a.email);
    const fresh = "Brand-New-Password-2026";
    await S.api.identity.completePasswordReset({ body: { token, newPassword: fresh } });
    // every session ends, including both devices
    expect((await S.raw("GET", "/api/v1/me", undefined, a.token)).status).toBe(401);
    expect((await S.raw("GET", "/api/v1/me", undefined, other.token)).status).toBe(401);
    await refused(S.login(a.email, a.password), 401);
    const s = await S.login(a.email, fresh);
    a = { ...a, api: s.api, token: s.token, password: fresh };
    expect(await S.sql("SELECT failed_count FROM users WHERE lower(email) = lower($1)", [a.email])).toEqual([
      { failed_count: 0 },
    ]);
    // used once
    await refused(S.api.identity.completePasswordReset({ body: { token, newPassword: "Another-Password-99" } }), 400);
    const audit = await S.sql<{ action: string; detail: string }>(
      "SELECT action, detail FROM audit_log WHERE action LIKE 'Password reset%' ORDER BY id",
    );
    expect(audit.map((x) => x.action)).toEqual([
      "Password reset requested — no link sent",
      "Password reset requested — no link sent",
      "Password reset link recorded",
      "Password reset with an e-mail link",
    ]);
    expect(audit[3]!.detail).toBe("2 session(s) signed out");
  });

  it("a newer link supersedes the older one; an expired link is refused; the new password follows the rules", async () => {
    await request(a.email);
    const first = (await latestToken(a.email)).token;
    await request(a.email);
    const second = (await latestToken(a.email)).token;
    await refused(
      S.api.identity.completePasswordReset({ body: { token: first, newPassword: "Superseded-Pass-1" } }),
      400,
    );
    await refused(S.api.identity.completePasswordReset({ body: { token: second, newPassword: "short" } }), 400);
    await S.sql("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
      sha256(second),
    ]);
    const err = await refused(
      S.api.identity.completePasswordReset({ body: { token: second, newPassword: "Expired-Link-Pass-1" } }),
      400,
    );
    expect(err.message).toMatch(/not valid or has expired/);
  });

  it("limits requests: per account silently (same answer, no new link), per address with 429", async () => {
    const before = (await S.sql("SELECT 1 FROM password_resets")).length;
    // the account already had 3 requests this hour (the limit): same answer, nothing new
    const r = await request(a.email);
    expect(r.status).toBe(200);
    expect((await S.sql("SELECT 1 FROM password_resets")).length).toBe(before);
    // per caller address: 12 recorded resets an hour from one address, then 429
    const others = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => signUpAndIn(S, "hotel")));
    const statuses: number[] = [];
    for (const o of others) statuses.push((await request(o.email)).status);
    expect(statuses).toContain(429);
    expect((await S.sql("SELECT 1 FROM password_resets")).length).toBe(12);
  });
});
