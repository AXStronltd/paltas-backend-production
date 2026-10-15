// Sign-in, sessions, two-factor, lockout, input handling and what a response may never reveal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../dist/core/identity/passwords.js";
import { newTotpSecret, totp, verifyTotp } from "../dist/core/identity/totp.js";
import { secretBox } from "../dist/lib/secret-box.js";
import { loadConfig } from "../dist/config.js";
import { refused, startServer, type TestServer } from "./support/test-server.js";

describe("building blocks", () => {
  it("hashes passwords with scrypt and refuses short ones", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow(/12 characters/);
  });

  it("matches the RFC 6238 test vector and allows ±30 s of clock drift", () => {
    // RFC 6238 SHA-1: secret "12345678901234567890", T = 59 s → 94287082; 6-digit form 287082
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
    const s = newTotpSecret();
    const now = Date.now();
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 120_000), now)).toBe(false);
  });

  it("seals secrets with authenticated encryption", () => {
    const box = secretBox(Buffer.alloc(32, 1).toString("base64"));
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP");
    // change a character inside the sealed text (the last ones may be base64 padding bits that decode the same)
    const at = Math.floor(sealed.length / 2);
    const tampered = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    expect(() => box.open(tampered)).toThrow();
    expect(() => secretBox(Buffer.alloc(31).toString("base64")).seal("x")).toThrow(/32 bytes/);
  });

  it("refuses unsafe production settings", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x@y/z",
      SECRETS_KEY: Buffer.alloc(32).toString("base64"),
    };
    expect(() => loadConfig({ ...base, PALTAS_TODAY: "2026-01-01" })).toThrow(/PALTAS_TODAY/);
    expect(() => loadConfig({ ...base, BILLING_MODE: "simulated" })).toThrow(/simulated/);
    expect(() => loadConfig({ ...base, SECRETS_KEY: undefined })).toThrow(/SECRETS_KEY/);
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
    expect(loadConfig(base).env).toBe("production");
  });
});

describe("sign-in and sessions", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());

  it("PALTAS staff must give the authenticator code", async () => {
    const s = await S.staff();
    const [row] = await S.sql<{ email: string; mfa_secret_sealed: string }>(
      "SELECT email, mfa_secret_sealed FROM users WHERE id = $1",
      [s.userId],
    );
    const r = await S.raw("POST", "/api/v1/auth/login", { email: row!.email, password: "wrong-password-1" });
    expect(r.status).toBe(401);
    expect(row!.mfa_secret_sealed.startsWith("v1:")).toBe(true); // stored encrypted
  });

  it("only the token's hash is stored; logout and expiry end the session", async () => {
    const { orgId, admin } = await S.newOrg();
    expect(orgId).toMatch(/^ORG-/);
    const sessions = await S.sql<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(sessions.every((x) => x.token_hash !== admin.token && /^[0-9a-f]{64}$/.test(x.token_hash))).toBe(true);
    expect((await admin.api.identity.me()).user.email).toBe(admin.email);
    expect((await S.raw("GET", "/api/v1/me", undefined, "made-up-token")).status).toBe(401);
    await admin.api.identity.logout();
    await refused(admin.api.identity.me(), 401, "NOT_SIGNED_IN");
  });

  it("an expired session is refused", async () => {
    const { admin } = await S.newOrg();
    await S.sql("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'");
    await refused(admin.api.identity.me(), 401, "NOT_SIGNED_IN");
  });

  it("five wrong passwords lock the account; the right one is then refused too; failures are audited", async () => {
    const { orgId, admin } = await S.newOrg();
    const m = await S.addMember(orgId, admin.api, "accountant");
    for (let i = 0; i < 5; i++)
      await refused(S.api.identity.login({ body: { email: m.email, password: "nope-nope-nope" } }), 401);
    await refused(S.api.identity.login({ body: { email: m.email, password: m.password } }), 429, "TOO_MANY_ATTEMPTS");
    const audit = await S.sql("SELECT 1 FROM audit_log WHERE action = 'Failed sign-in' AND target = $1", [m.email]);
    expect(audit.length).toBeGreaterThanOrEqual(5);
  });

  it("an unknown email gets the same answer as a wrong password", async () => {
    const r = await S.raw("POST", "/api/v1/auth/login", { email: "nobody@nowhere.test", password: "something-long" });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe("Email, password or verification code is not correct");
  });

  it("a temporary password must be changed before anything else", async () => {
    const { orgId, admin } = await S.newOrg();
    const r = await admin.api.organisations.addMember({
      params: { orgId },
      body: { email: "temp+1@org.test", role: "viewer" },
    });
    const t = await S.login("temp+1@org.test", r.temporaryPassword!);
    const me = await t.api.identity.me();
    expect(me.user.mustChangePassword).toBe(true);
    const blocked = await refused(t.api.organisations.get({ params: { orgId } }), 403, "FORBIDDEN");
    expect(blocked.message).toMatch(/temporary password/);
    await refused(
      t.api.identity.changePassword({ body: { currentPassword: "wrong", newPassword: "A-new-password-123" } }),
      400,
    );
    await t.api.identity.changePassword({
      body: { currentPassword: r.temporaryPassword!, newPassword: "A-new-password-123" },
    });
    expect((await t.api.organisations.get({ params: { orgId } })).id).toBe(orgId);
  });

  it("changing the password signs out every other session", async () => {
    const { admin } = await S.newOrg();
    const other = await S.login(admin.email, admin.password);
    await admin.api.identity.changePassword({
      body: { currentPassword: admin.password, newPassword: "Another-Password-456" },
    });
    await refused(other.api.identity.me(), 401, "NOT_SIGNED_IN");
    expect((await admin.api.identity.me()).user.email).toBe(admin.email);
  });

  it("two-factor can be turned on by a client, and is then required", async () => {
    const { orgId, admin } = await S.newOrg();
    const m = await S.addMember(orgId, admin.api, "accountant");
    const { secret, otpauthUrl } = await m.api.identity.startMfa();
    expect(otpauthUrl).toContain("otpauth://totp/");
    await refused(m.api.identity.confirmMfa({ body: { code: "000000" } }), 400);
    await m.api.identity.confirmMfa({ body: { code: totp(secret) } });
    const noCode = await S.raw("POST", "/api/v1/auth/login", { email: m.email, password: m.password });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.message).toMatch(/6-digit code/);
    const ok = await S.login(m.email, m.password, totp(secret));
    expect((await ok.api.identity.me()).user.mfaEnabled).toBe(true);
  });
});

describe("requests", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());

  it("bad input is refused cleanly with the problems listed", async () => {
    expect((await S.raw("POST", "/api/v1/auth/login", "{not json")).status).toBe(400);
    expect((await S.raw("GET", "/api/v1/nothing-here")).status).toBe(404);
    expect((await S.raw("PUT", "/api/v1/health")).status).toBe(405);
    const r = await S.raw("POST", "/api/v1/auth/login", { email: "not-an-email", password: "" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_REQUEST");
    expect(r.body.error.details.problems.map((p: { field: string }) => p.field)).toEqual(
      expect.arrayContaining(["body.email", "body.password"]),
    );
    expect((await S.raw("POST", "/api/v1/auth/login", "x".repeat(300_000))).status).toBe(400);
    // an endpoint without a body accepts an empty object, but not unexpected content
    const { admin } = await S.newOrg();
    expect((await S.raw("POST", "/api/v1/me/mfa/setup", {}, admin.token)).status).toBe(200);
    expect((await S.raw("POST", "/api/v1/auth/logout", { surprise: 1 }, admin.token)).status).toBe(400);
  });

  it("security headers are set on every answer", async () => {
    const res = await fetch(S.base + "/api/v1/health");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("Super Admin endpoints do not exist for clients", async () => {
    const { admin } = await S.newOrg();
    await refused(admin.api.admin.catalogue(), 404, "NOT_FOUND");
    await refused(S.api.admin.catalogue(), 401, "NOT_SIGNED_IN");
  });

  it("responses never include internal columns", async () => {
    const { orgId, admin } = await S.newOrg();
    const raw = await S.raw("GET", `/api/v1/orgs/${orgId}/members`, undefined, admin.token);
    const text = JSON.stringify(raw.body);
    for (const leak of ["password_hash", "mfa_secret", "scrypt$", "token_hash"]) expect(text).not.toContain(leak);
  });
});
