import { afterEach, describe, it, expect } from "vitest";
import { startServer, type TestServer } from "./support/test-server.js";
import { hashPassword } from "../dist/core/identity/passwords.js";
import { newTotpSecret, totp } from "../dist/core/identity/totp.js";
import { backupDigest } from "../dist/core/identity/staff-enrollment.js";
let S: TestServer;
afterEach(async () => {
  if (S) await S.close();
});
async function fixture() {
  let link = "";
  S = await startServer({
    config: {
      email: {
        provider: "resend",
        apiKey: "fixture",
        fromAddress: "security@paltas.test",
        fromName: "PALTAS",
        notConfigured: null,
        smtp: null,
        webhookSecret: null,
        apiUrl: null,
      },
    },
    emailTransport: {
      fetch: async (_u, o) => {
        const b = JSON.parse(String(o?.body));
        link = /password-reset=([\w-]+)/.exec(b.text)?.[1] ?? "";
        return new Response(JSON.stringify({ id: "accepted-test" }), { status: 200 });
      },
    },
  });
  const staff = await S.staff(),
    secret = newTotpSecret(),
    email = "owner@reset.test";
  await S.sql(
    "UPDATE users SET email=$2,password_hash=$3,mfa_secret_sealed=$4,mfa_confirmed_at=now(),mfa_last_step=NULL WHERE id=$1",
    [staff.userId, email, await hashPassword("Old-Password-2026!"), S.app.ctx.secrets.seal(secret)],
  );
  await S.sql("INSERT INTO staff_backup_codes(user_id,code_hash) VALUES($1,$2)", [
    staff.userId,
    backupDigest("BACKUP-1234567890"),
  ]);
  const request = () => S.api.identity.requestStaffPasswordReset({ body: { email } });
  const complete = (token = link, code = totp(secret)) =>
    S.api.identity.completeStaffPasswordReset({ body: { token, newPassword: "New-Password-2026!", code } });
  return {
    staff,
    secret,
    email,
    request,
    complete,
    get token() {
      return link;
    },
  };
}
describe("staff password reset requires mailbox and existing MFA", () => {
  it("has uniform replies and never sends customer or unknown links", async () => {
    const f = await fixture();
    const a = await S.api.identity.requestStaffPasswordReset({ body: { email: "unknown@reset.test" } });
    expect(f.token).toBe("");
    const org = await S.newOrg();
    const b = await S.api.identity.requestStaffPasswordReset({ body: { email: org.admin.email } });
    expect(f.token).toBe("");
    expect(await f.request()).toEqual(a);
    expect(b).toEqual(a);
    expect(f.token.length).toBeGreaterThan(20);
  });
  it("resets once, preserves MFA and role, revokes sessions and allows fresh login", async () => {
    const f = await fixture();
    await f.request();
    const token = f.token;
    await f.complete();
    await expect(f.complete(token)).rejects.toBeTruthy();
    const [u] = await S.sql("SELECT staff_role,mfa_secret_sealed FROM users WHERE id=$1", [f.staff.userId]);
    expect(u.staff_role).toBe("super_admin");
    expect(S.app.ctx.secrets.open(u.mfa_secret_sealed)).toBe(f.secret);
    expect((await S.sql("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1", [f.staff.userId]))[0].n).toBe(0);
    await expect(S.login(f.email, "Old-Password-2026!", totp(f.secret))).rejects.toBeTruthy();
    const signed = await S.login(f.email, "New-Password-2026!", totp(f.secret, Date.now() + 30000));
    expect((await signed.api.identity.me()).user.staffRole).toBe("super_admin");
  });
  it("rejects expired TOTP and exhausts five attempts without resetting password", async () => {
    const f = await fixture();
    await f.request();
    for (let i = 0; i < 5; i++)
      await expect(f.complete(f.token, totp(f.secret, Date.now() - 120000))).rejects.toBeTruthy();
    await expect(f.complete()).rejects.toBeTruthy();
    expect((await S.sql("SELECT attempts FROM staff_password_resets"))[0].attempts).toBe(5);
  });
  it("supersedes links, rejects expired links and changed account identity", async () => {
    const f = await fixture();
    await f.request();
    const first = f.token;
    await f.request();
    await expect(f.complete(first)).rejects.toBeTruthy();
    await S.sql("UPDATE staff_password_resets SET expires_at=now()-interval '1 second'");
    await expect(f.complete()).rejects.toBeTruthy();
    await f.request();
    await S.sql("UPDATE users SET password_hash=$2 WHERE id=$1", [
      f.staff.userId,
      await hashPassword("Changed-Password-2026!"),
    ]);
    await expect(f.complete()).rejects.toBeTruthy();
  });
  it("atomically consumes backup code and token under concurrent submission", async () => {
    const f = await fixture();
    await f.request();
    const input = { token: f.token, newPassword: "New-Password-2026!", backupCode: "BACKUP-1234567890" };
    const results = await Promise.allSettled([
      S.api.identity.completeStaffPasswordReset({ body: input }),
      S.api.identity.completeStaffPasswordReset({ body: input }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await S.sql("SELECT used_at FROM staff_backup_codes"))[0].used_at).toBeTruthy();
  });
  it("refuses revoked staff and missing factors; limits unknown account requests too", async () => {
    const f = await fixture();
    await f.request();
    await expect(
      S.api.identity.completeStaffPasswordReset({ body: { token: f.token, newPassword: "New-Password-2026!" } }),
    ).rejects.toBeTruthy();
    await S.sql("UPDATE users SET active=false WHERE id=$1", [f.staff.userId]);
    await expect(f.complete()).rejects.toBeTruthy();
    for (let i = 0; i < 8; i++)
      await S.api.identity
        .requestStaffPasswordReset({ body: { email: "unknown" + i + "@reset.test" } })
        .catch(() => {});
    expect((await S.raw("POST", "/api/v1/auth/staff-password-reset", { email: "any@reset.test" })).status).toBe(429);
  });
});
