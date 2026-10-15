// The first PALTAS Super Admin in production: the command works only while no staff account exists, prints a
// temporary password and an authenticator secret once, is audited, and is refused on every later run. Staff and
// client accounts never mix (also enforced by the database).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapFirstSuperAdmin } from "../dist/core/admin/bootstrap.js";
import { createUser } from "../dist/core/identity/identity.service.js";
import { totp } from "../dist/core/identity/totp.js";
import { refused, startServer, type TestServer } from "./support/test-server.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../dist/scripts/bootstrap-admin.js", import.meta.url));
/** The owner's documented command (`npm run bootstrap -- <email> <file>`); bootstrap-admin.js is the same command. */
const OWNER_SCRIPT = fileURLToPath(new URL("../dist/scripts/bootstrap.js", import.meta.url));
/** The key the test servers use (outside production), so the server can read the secret the command sealed. */
const KEY = Buffer.alloc(32, 7).toString("base64");

async function bootstrap(databaseUrl: string, email: string) {
  return runScript(databaseUrl, [SCRIPT, "--email", email, "--name", "PALTAS Operations"]);
}

async function runScript(databaseUrl: string, argv: string[]) {
  try {
    const r = await run(process.execPath, argv, {
      env: { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: databaseUrl, SECRETS_KEY: KEY },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("first Super Admin (production command)", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());

  it("creates the first Super Admin once, with a temporary password and two-factor, and audits it", async () => {
    const email = `ops+${randomBytes(3).toString("hex")}@paltashub.test`;
    const first = await bootstrap(S.app.ctx.config.databaseUrl, email);
    expect([first.code, first.stderr]).toEqual([0, ""]);
    expect(first.stdout).toMatch(/First PALTAS Super Admin created \(production\)/);
    const temporary = /temporary password:\s+(\S+)/.exec(first.stdout)?.[1] as string;
    const secret = /authenticator secret:\s+(\S+)/.exec(first.stdout)?.[1] as string;
    expect(temporary.length).toBeGreaterThanOrEqual(12);
    // only hashes and the sealed secret are stored
    const [u] = await S.sql<{
      password_hash: string;
      mfa_secret_sealed: string;
      must_change_password: boolean;
      staff_role: string;
    }>("SELECT * FROM users WHERE email = $1", [email]);
    expect(u!.staff_role).toBe("super_admin");
    expect(u!.must_change_password).toBe(true);
    expect(u!.password_hash).not.toContain(temporary);
    expect(u!.mfa_secret_sealed).not.toContain(secret);

    // sign-in needs the authenticator code
    await refused(S.client().identity.login({ body: { email, password: temporary } }), 401);
    const s = await S.login(email, temporary, totp(secret));
    // nothing but changing the password until it is changed
    const blocked = await refused(s.api.admin.listOrganisations(), 403);
    expect(blocked.details).toEqual({ mustChangePassword: true });
    await s.api.identity.changePassword({ body: { currentPassword: temporary, newPassword: "A-New-Long-Password-1" } });
    expect((await s.api.admin.listOrganisations()).organisations).toEqual([]);

    // a second run is refused, whatever the e-mail, and the refusal is audited
    const second = await bootstrap(S.app.ctx.config.databaseUrl, "someone-else@paltashub.test");
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/Refused: A PALTAS staff account already exists/);
    expect(second.stdout).not.toMatch(/temporary password/);
    expect((await S.sql("SELECT 1 FROM users WHERE staff_role IS NOT NULL")).length).toBe(1);
    const audit = await s.api.ops.auditSearch({ query: { q: "First Super Admin" } });
    expect(audit.entries.map((e) => [e.action, e.target, e.actorRole])).toEqual([
      ["First Super Admin bootstrap refused", "someone-else@paltashub.test", "system"],
      ["First Super Admin created", email, "system"],
    ]);
  });

  it("refuses without an e-mail address", async () => {
    const r = await run(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        DATABASE_URL: S.app.ctx.config.databaseUrl,
        SECRETS_KEY: KEY,
      },
    }).catch((e: { code: number; stderr: string }) => e);
    expect([(r as { code: number }).code, (r as { stderr: string }).stderr]).toEqual([
      2,
      expect.stringMatching(/Usage/),
    ]);
  });
});

describe("first Super Admin rules", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());
  const db = () => S.app.ctx.db;

  it("never turns a client account into staff, and two runs at the same moment create one account", async () => {
    const client = await createUser(db(), { email: "owner@tower.test", name: "Building owner" });
    await expect(
      bootstrapFirstSuperAdmin(db(), S.app.ctx.secrets, { email: "Owner@Tower.test", name: "Owner" }),
    ).rejects.toThrow(/belongs to an existing client account/);
    expect((await S.sql("SELECT staff_role FROM users WHERE id = $1", [client.id]))[0]).toEqual({ staff_role: null });

    const both = await Promise.allSettled([
      bootstrapFirstSuperAdmin(db(), S.app.ctx.secrets, { email: "a@paltas.test", name: "Admin A" }),
      bootstrapFirstSuperAdmin(db(), S.app.ctx.secrets, { email: "b@paltas.test", name: "Admin B" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String(both.find((r) => r.status === "rejected")?.reason)).toMatch(/already exists/);
    expect((await S.sql("SELECT 1 FROM users WHERE staff_role IS NOT NULL")).length).toBe(1);
  });

  it("the database keeps staff and client organisations apart, whatever the code does", async () => {
    const { orgId } = await S.newOrg({ name: "Tower Owners Ltd" });
    const [staff] = await S.sql<{ id: string }>("SELECT id FROM users WHERE staff_role IS NOT NULL LIMIT 1");
    await expect(
      S.sql("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'org_admin')", [orgId, staff!.id]),
    ).rejects.toThrow(/cannot join a client organisation/);
    const [member] = await S.sql<{ user_id: string }>("SELECT user_id FROM memberships WHERE org_id = $1 LIMIT 1", [
      orgId,
    ]);
    await expect(
      S.sql("UPDATE users SET staff_role = 'super_admin', mfa_secret_sealed = 'x' WHERE id = $1", [member!.user_id]),
    ).rejects.toThrow(/cannot become PALTAS staff/);
  });
});

describe("first Super Admin — the owner's command (npm run bootstrap -- <email> <file>)", () => {
  let S: TestServer;
  let dir: string;
  beforeAll(async () => {
    S = await startServer();
    dir = await mkdtemp(join(tmpdir(), "paltas-bootstrap-"));
  });
  afterAll(() => S.close());
  const url = () => S.app.ctx.config.databaseUrl;
  const staff = async () => (await S.sql("SELECT 1 FROM users WHERE staff_role IS NOT NULL")).length;

  it("writes the credentials to a new owner-only file, prints no secret, and the account follows the same rules", async () => {
    // an existing file is never overwritten, and then no account is created whose secrets were never handed over
    const taken = join(dir, "taken.txt");
    await writeFile(taken, "keep me");
    const blocked = await runScript(url(), [OWNER_SCRIPT, "first@paltashub.test", taken]);
    expect(blocked.code).not.toBe(0);
    expect(await readFile(taken, "utf8")).toBe("keep me");
    expect(await staff()).toBe(0);

    const file = join(dir, "superadmin.txt");
    const r = await runScript(url(), [OWNER_SCRIPT, "First@PaltasHub.test", file]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toMatch(/First PALTAS Super Admin first@paltashub\.test created \(production\)/);
    expect(r.stdout).toMatch(/Catalogue checked/);
    const text = await readFile(file, "utf8");
    const temporary = /temporary password:\s+(\S+)/.exec(text)?.[1] as string;
    const secret = /authenticator secret:\s+(\S+)/.exec(text)?.[1] as string;
    expect(r.stdout).not.toContain(temporary);
    expect(r.stdout).not.toContain(secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const [u] = await S.sql<{ must_change_password: boolean; staff_role: string }>(
      "SELECT must_change_password, staff_role FROM users WHERE email = 'first@paltashub.test'",
    );
    expect(u).toEqual({ must_change_password: true, staff_role: "super_admin" });
    const s = await S.login("first@paltashub.test", temporary, totp(secret));
    await refused(s.api.admin.listOrganisations(), 403);
  });
});

describe("first Super Admin — a live database the first `npm run bootstrap` already set up", () => {
  let S: TestServer;
  let dir: string;
  beforeAll(async () => {
    S = await startServer();
    dir = await mkdtemp(join(tmpdir(), "paltas-bootstrap-"));
  });
  afterAll(() => S.close());

  it("refuses every run, audits it, creates nothing and resets nothing", async () => {
    // what the first version of the command left: a Super Admin with a generated password (no forced change) and 2FA
    await createUser(S.app.ctx.db, {
      email: "owner-admin@paltashub.test",
      name: "PALTAS Super Admin",
      password: "Chosen-Long-Password-1",
      staffRole: "super_admin",
      mfaSecretSealed: S.app.ctx.secrets.seal("JBSWY3DPEHPK3PXP"),
    });
    const all = "SELECT id, email, password_hash, must_change_password, mfa_secret_sealed FROM users ORDER BY id";
    const before = await S.sql(all);
    const file = join(dir, "second.txt");
    for (const argv of [
      [OWNER_SCRIPT, "owner-admin@paltashub.test", file],
      [OWNER_SCRIPT, "another@paltashub.test", file],
      [SCRIPT, "--email", "another@paltashub.test"],
    ]) {
      const r = await runScript(S.app.ctx.config.databaseUrl, argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Refused: A PALTAS staff account already exists/);
      expect(r.stdout).not.toMatch(/temporary password/);
    }
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
    expect(await S.sql(all)).toEqual(before);
    const refusals = await S.sql("SELECT 1 FROM audit_log WHERE action = 'First Super Admin bootstrap refused'");
    expect(refusals.length).toBe(3);
  });
});
