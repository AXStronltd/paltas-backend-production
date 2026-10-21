import { afterEach, describe, expect, it } from "vitest";
import { staffEnrollmentService } from "../dist/core/identity/staff-enrollment.js";
import { totp } from "../dist/core/identity/totp.js";
import { startServer, type TestServer } from "./support/test-server.js";

const password = "New-Owner-Password-2026!";
let S: TestServer;
afterEach(async () => {
  if (S) await S.close();
});
async function fixture(first = false) {
  let emailCode = "",
    url = "";
  S = await startServer({
    config: {
      email: {
        provider: "resend",
        apiKey: "test-only",
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
        const body = JSON.parse(String(o?.body));
        emailCode = /code is: (\d{8})/.exec(body.text)?.[1] ?? "";
        return new Response(JSON.stringify({ id: "email-fixture" }), { status: 200 });
      },
    },
  });
  let email = "new-owner@paltas.test",
    oldToken: string | null = null;
  if (!first) {
    const staff = await S.staff();
    oldToken = staff.token;
    const [u] = await S.sql("SELECT email FROM users WHERE id=$1", [staff.userId]);
    email = u.email;
  }
  const service = staffEnrollmentService(S.app.ctx);
  await service.issue({ email, operator: "Hosting admin approved fixture identity", createFirst: first }, async (x) => {
    url = x;
  });
  const token = url.split("#enroll=")[1]!;
  return {
    service,
    email,
    get emailCode() {
      return emailCode;
    },
    token,
    oldToken,
  };
}
describe("operator and mailbox gated staff enrollment", () => {
  it("leaves new owner disabled until first code, then issues hashed backups and no admin session", async () => {
    const f = await fixture(true);
    expect((await S.sql("SELECT active,mfa_secret_sealed FROM users WHERE email=$1", [f.email]))[0]).toMatchObject({
      active: false,
      mfa_secret_sealed: null,
    });
    await expect(S.api.identity.login({ body: { email: f.email, password } })).rejects.toBeTruthy();
    const pending = await S.api.identity.beginStaffEnrollment({ body: { token: f.token, emailCode: f.emailCode } });
    expect(pending.otpauthUrl).toContain("otpauth://totp/");
    expect((await S.sql("SELECT active FROM users WHERE email=$1", [f.email]))[0].active).toBe(false);
    const done = await S.api.identity.completeStaffEnrollment({
      body: { token: f.token, code: totp(pending.secret), newPassword: password },
    });
    expect(done.backupCodes).toHaveLength(10);
    const [u] = await S.sql("SELECT active,mfa_confirmed_at,mfa_secret_sealed FROM users WHERE email=$1", [f.email]);
    expect(u.active).toBe(true);
    expect(u.mfa_confirmed_at).toBeTruthy();
    expect(u.mfa_secret_sealed).not.toContain(pending.secret);
    expect((await S.sql("SELECT 1 FROM sessions")).length).toBe(0);
    expect(
      (await S.sql("SELECT code_hash FROM staff_backup_codes")).every((x) => !done.backupCodes.includes(x.code_hash)),
    ).toBe(true);
    // Enrollment TOTP cannot be immediately replayed for login. A backup remains a valid second factor.
    await expect(
      S.api.identity.login({ body: { email: f.email, password, code: totp(pending.secret) } }),
    ).rejects.toBeTruthy();
    const login = await S.api.identity.loginWithBackup({
      body: { email: f.email, password, backupCode: done.backupCodes[0]! },
    });
    expect((await S.client(login.token).admin.listOrganisations()).organisations).toEqual([]);
    await expect(
      S.api.identity.loginWithBackup({ body: { email: f.email, password, backupCode: done.backupCodes[0]! } }),
    ).rejects.toBeTruthy();
    await expect(
      S.api.identity.completeStaffEnrollment({
        body: { token: f.token, code: totp(pending.secret), newPassword: password },
      }),
    ).rejects.toBeTruthy();
  });
  it("requires mailbox proof and preserves an existing owner until successful activation", async () => {
    const f = await fixture();
    const before = await S.sql("SELECT password_hash,mfa_secret_sealed,staff_role FROM users WHERE email=$1", [
      f.email,
    ]);
    await expect(f.service.begin(f.token, "00000000")).rejects.toBeTruthy();
    expect(
      await S.sql("SELECT password_hash,mfa_secret_sealed,staff_role FROM users WHERE email=$1", [f.email]),
    ).toEqual(before);
    const p = await f.service.begin(f.token, f.emailCode);
    expect((await S.client(f.oldToken).admin.listOrganisations()).organisations).toEqual([]);
    const bad = totp(p.secret) === "000000" ? "111111" : "000000";
    await expect(f.service.complete(f.token, bad, password)).rejects.toBeTruthy();
    expect(
      await S.sql("SELECT password_hash,mfa_secret_sealed,staff_role FROM users WHERE email=$1", [f.email]),
    ).toEqual(before);
    await f.service.complete(f.token, totp(p.secret), password);
    await expect(S.client(f.oldToken).admin.listOrganisations()).rejects.toBeTruthy();
    expect((await S.sql("SELECT staff_role FROM users WHERE email=$1", [f.email]))[0].staff_role).toBe("super_admin");
  });
  it("expires grants and permanently exhausts failed verification attempts", async () => {
    const f = await fixture();
    await S.sql("UPDATE staff_enrollments SET expires_at=now()-interval '1 minute'");
    await expect(f.service.begin(f.token, f.emailCode)).rejects.toBeTruthy();
    await S.sql("UPDATE staff_enrollments SET expires_at=now()+interval '15 minutes'");
    for (let n = 0; n < 5; n++) await expect(f.service.begin(f.token, "00000000")).rejects.toBeTruthy();
    await expect(f.service.begin(f.token, f.emailCode)).rejects.toBeTruthy();
    expect((await S.sql("SELECT attempts FROM staff_enrollments"))[0].attempts).toBe(5);
  });
  it("allows exactly one concurrent backup-code redemption, and never without the password", async () => {
    const f = await fixture();
    const p = await f.service.begin(f.token, f.emailCode);
    const d = await f.service.complete(f.token, totp(p.secret), password);
    await expect(
      S.api.identity.loginWithBackup({
        body: { email: f.email, password: "Wrong-password!", backupCode: d.backupCodes[0]! },
      }),
    ).rejects.toBeTruthy();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        S.api.identity.loginWithBackup({ body: { email: f.email, password, backupCode: d.backupCodes[0]! } }),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("supersedes grants and refuses account changes during setup", async () => {
    const f = await fixture();
    let next = "";
    await f.service.issue({ email: f.email, operator: "Independent hosting approval second" }, async (x) => {
      next = x;
    });
    await expect(f.service.begin(f.token, f.emailCode)).rejects.toBeTruthy();
    await S.sql("UPDATE users SET active=false WHERE email=$1", [f.email]);
    await expect(f.service.begin(next.split("#enroll=")[1]!, f.emailCode)).rejects.toBeTruthy();
  });
  it("blocks unauthorised setup, customer elevation, cross-origin access and caches", async () => {
    const f = await fixture();
    await expect(f.service.issue({ email: f.email, operator: "" }, async () => {})).rejects.toBeTruthy();
    await expect(
      f.service.issue({ email: "customer@paltas.test", operator: "Hosting admin fixture approval" }, async () => {}),
    ).rejects.toBeTruthy();
    const response = await fetch(S.base + "/api/v1/auth/staff-enrollment/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: f.token, emailCode: f.emailCode }),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const denied = await S.raw(
      "POST",
      "/api/v1/auth/staff-enrollment/begin",
      { token: f.token, emailCode: f.emailCode },
      null,
      { origin: "https://evil.invalid" },
    );
    expect(denied.status).toBe(403);
    await expect(S.client(f.token).admin.listOrganisations()).rejects.toBeTruthy();
  });
  it("permits only one concurrent activation and invalidates old backup sets on re-enrollment", async () => {
    const f = await fixture();
    const p = await f.service.begin(f.token, f.emailCode);
    const results = await Promise.allSettled([1, 2].map(() => f.service.complete(f.token, totp(p.secret), password)));
    const successful = results.filter(
      (x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.complete>>> => x.status === "fulfilled",
    );
    expect(successful).toHaveLength(1);
    const oldCode = successful[0]!.value.backupCodes[0]!;
    let url = "";
    await f.service.issue({ email: f.email, operator: "Hosting reviewer approval second" }, async (x) => {
      url = x;
    });
    const token = url.split("#enroll=")[1]!;
    const next = await f.service.begin(token, f.emailCode);
    await f.service.complete(token, totp(next.secret), password);
    await expect(
      S.api.identity.loginWithBackup({ body: { email: f.email, password, backupCode: oldCode } }),
    ).rejects.toBeTruthy();
    expect((await S.sql("SELECT 1 FROM staff_backup_codes")).length).toBe(10);
  });
  it("requires email acceptance and private grant delivery, with no pending account left after failure", async () => {
    const f = await fixture(true);
    await expect(
      f.service.issue({ email: f.email, operator: "Hosting reviewer approval callback" }, async () => {
        throw Error("Private file unavailable");
      }),
    ).rejects.toBeTruthy();
    expect((await S.sql("SELECT 1 FROM staff_enrollments WHERE revoked_at IS NULL")).length).toBe(1);
    const noMail = staffEnrollmentService({
      ...S.app.ctx,
      config: { ...S.app.ctx.config, email: { ...S.app.ctx.config.email, provider: null } },
    });
    await expect(
      noMail.issue(
        { email: "other-owner@paltas.test", operator: "Hosting reviewer approval no provider", createFirst: true },
        async () => {},
      ),
    ).rejects.toBeTruthy();
    expect((await S.sql("SELECT 1 FROM users WHERE email='other-owner@paltas.test'")).length).toBe(0);
  });
});
