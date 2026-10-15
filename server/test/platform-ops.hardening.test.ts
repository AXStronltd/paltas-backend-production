// Production hardening: readiness (database + migrations) separate from health, rate limits on sensitive routes per
// person or address, logs without secrets, and the shutdown order (HTTP → workers → database pool).
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { connect } from "../dist/db/database.js";
import { LOG_REDACT } from "../dist/http/logging.js";
import { signedPost, standInProduct } from "./support/platform-fixtures.js";
import { adminUrl, dbUrl, templateName } from "./support/global-setup.js";
import { refused, startServer, type TestServer } from "./support/test-server.js";

async function freshDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `paltas_test_hard_${process.pid}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateName()}`);
  await admin.end();
  return {
    url: dbUrl(name),
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

describe("readiness", () => {
  let S: TestServer;
  beforeAll(async () => (S = await startServer()));
  afterAll(() => S.close());

  it("is ready when the database answers and every migration is applied; /health checks the process and the database only", async () => {
    const ok = await S.raw("GET", "/api/v1/ready");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ready: true, database: "up", migrations: { pending: [] } });
    expect(ok.body.migrations.applied).toBeGreaterThanOrEqual(7);

    const [row] = await S.sql<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version = '0012_platform_ops'",
    );
    await S.sql("DELETE FROM schema_migrations WHERE version = '0012_platform_ops'");
    const pending = await S.raw("GET", "/api/v1/ready");
    expect([pending.status, pending.body.error.message, pending.body.error.details]).toEqual([
      503,
      "Not ready: 1 migration(s) not applied",
      { pending: ["0012_platform_ops"] },
    ]);
    expect((await S.raw("GET", "/api/v1/health")).status).toBe(200);
    await S.sql("INSERT INTO schema_migrations (version, checksum) VALUES ('0012_platform_ops', $1)", [row!.checksum]);
    expect((await S.raw("GET", "/api/v1/ready")).status).toBe(200);
  });

  it("is not ready when the database does not answer", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: dbUrl("paltas_no_such_database_" + process.pid),
    });
    const fresh = await freshDatabase();
    const db = connect(fresh.url, 1);
    const app = await buildApp({ ...config, databaseUrl: fresh.url }, { db, migrate: false, products: [] });
    try {
      expect((await app.server.inject({ method: "GET", url: "/api/v1/ready" })).statusCode).toBe(200);
      // the database goes away under a running server
      await db.close();
      const r = await app.server.inject({ method: "GET", url: "/api/v1/ready" });
      expect([r.statusCode, JSON.parse(r.body).error.message]).toEqual([
        503,
        "Not ready: the database does not answer",
      ]);
      // /api/v1/health (Render's health check) also answers 503 when the database cannot be reached
      const h = await app.server.inject({ method: "GET", url: "/api/v1/health" });
      expect([h.statusCode, JSON.parse(h.body).error.message]).toEqual([503, "The database is not reachable"]);
    } finally {
      await app.close();
      await fresh.drop();
    }
  });
});

describe("rate limits on sensitive routes", () => {
  let S: TestServer;
  const SECRET = "whsec_rl_" + randomBytes(8).toString("hex");
  beforeAll(
    async () =>
      (S = await startServer({
        config: { sensitiveRateLimitPerMinute: 3, webhookRateLimitPerMinute: 2, webhookSecrets: { rlpay: SECRET } },
      })),
  );
  afterAll(() => S.close());

  it("password changes are limited per person, not per address", async () => {
    const a = (await S.newOrg()).admin;
    const b = (await S.newOrg()).admin;
    const wrong = { currentPassword: "not-my-password", newPassword: "Another-Long-Password-9" };
    // the first sign-in already changed the temporary password once: two more attempts reach the limit of three
    for (let i = 0; i < 2; i++) await refused(a.api.identity.changePassword({ body: wrong }), 400);
    const r = await refused(a.api.identity.changePassword({ body: wrong }), 429, "TOO_MANY_ATTEMPTS");
    expect(r.message).toBe("Too many requests — wait a minute and try again");
    // someone else on the same address is not affected
    await refused(b.api.identity.changePassword({ body: wrong }), 400);
    // ordinary reads are not limited
    for (let i = 0; i < 6; i++) await a.api.identity.me();
  });

  it("Super Admin changes are limited; Super Admin reads are not", async () => {
    const sa = await S.staff();
    for (let i = 0; i < 3; i++)
      await refused(sa.api.ops.suspendOrg({ params: { orgId: "ORG-NONE" }, body: { reason: "Rate limit test" } }), 404);
    await refused(sa.api.ops.suspendOrg({ params: { orgId: "ORG-NONE" }, body: { reason: "Rate limit test" } }), 429);
    for (let i = 0; i < 6; i++) await sa.api.ops.listJobs();
  });

  it("provider webhooks are limited per address", async () => {
    const ev = { id: "e1", messageId: "m1", status: "sent" };
    expect((await signedPost(S, "/api/v1/webhooks/notifications/rlpay", ev, "bad")).status).toBe(401);
    expect((await signedPost(S, "/api/v1/webhooks/notifications/rlpay", ev, "bad")).status).toBe(401);
    expect((await signedPost(S, "/api/v1/webhooks/notifications/rlpay", ev, SECRET)).status).toBe(429);
  });
});

describe("structured logs", () => {
  it("never carry passwords, tokens, codes or secrets", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const f = Fastify({ logger: { level: "info", redact: LOG_REDACT, stream: sink } });
    f.log.info({ body: { email: "a@b.c", password: "hunter2-hunter2", code: "123456" } }, "login attempt");
    f.log.info(
      { result: { temporaryPassword: "Tmp-1234567890", authenticatorSecret: "JBSWY3DPEHPK3PXP" } },
      "bootstrap",
    );
    f.log.info({ req: { headers: { authorization: "Bearer abc.def", "x-paltas-signature": "t=1,v1=ff" } } }, "request");
    f.log.info({ user: { token: "s3cr3t-token", password_hash: "scrypt$..." } }, "session");
    await f.close();
    const out = lines.join("");
    for (const secret of [
      "hunter2",
      "123456",
      "Tmp-1234567890",
      "JBSWY3DPEHPK3PXP",
      "abc.def",
      "v1=ff",
      "s3cr3t-token",
      "scrypt$",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain("a@b.c");
    const [login, boot, , session] = lines.map((l) => JSON.parse(l) as Record<string, Record<string, string>>);
    expect(login!.body).toEqual({ email: "a@b.c", password: "[redacted]", code: "[redacted]" });
    expect(boot!.result).toEqual({ temporaryPassword: "[redacted]", authenticatorSecret: "[redacted]" });
    expect(session!.user).toEqual({ token: "[redacted]", password_hash: "[redacted]" });
  });
});

describe("graceful shutdown", () => {
  it("stops HTTP first, lets the running scheduled job finish, and only then closes the database pool", async () => {
    const fresh = await freshDatabase();
    const stand = standInProduct();
    stand.behaviour.delayMs = 600;
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: fresh.url,
      MIGRATION_WORKER: "false",
      SCHEDULER_WORKER: "true",
      SCHEDULER_POLL_MS: "50",
    });
    const check = connect(fresh.url, 1);
    try {
      const app = await buildApp(config, { migrate: false, products: [stand.module] });
      await app.server.listen({ host: "127.0.0.1", port: 0 });
      const addr = app.server.server.address();
      const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      await check.run("UPDATE sched_jobs SET status = 'paused', paused_reason = 'test' WHERE org_id IS NULL");
      await check.run(
        "INSERT INTO organisations (id, name, legal_name, country, currency) VALUES ('ORG-SHUT', 'Shutdown Hotel', 'Shutdown Hotel', 'Kenya', 'KES')",
      );
      await app.core.db.tx((t) =>
        app.core.scheduler.ensureJob(t, {
          key: "test.night_audit",
          orgId: "ORG-SHUT",
          label: "Audit",
          cron: "0 2 * * *",
          timezone: "UTC",
        }),
      );
      await check.run(
        `INSERT INTO sched_runs (id, job_id, org_id, period, trigger, status, due_at, scheduled_for, max_attempts)
         SELECT 'run_shutdown', id, org_id, 'manual:shutdown', 'manual', 'queued', now(), now(), 3 FROM sched_jobs WHERE org_id = 'ORG-SHUT'`,
      );
      // wait until the worker has started the run
      for (let i = 0; i < 100 && !stand.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(stand.calls).toHaveLength(1);
      expect(stand.behaviour.finished).toBe(0);

      await app.close();
      // the run finished and its result was written before the pool closed
      expect(stand.behaviour.finished).toBe(1);
      const [r] = await check.rows<{ status: string; summary: string }>(
        "SELECT status, summary FROM sched_runs WHERE id = 'run_shutdown'",
      );
      expect(r).toEqual({ status: "succeeded", summary: expect.stringMatching(/^Night audit for .* completed$/) });
      // HTTP is gone
      await expect(fetch(base + "/api/v1/health")).rejects.toThrow();
    } finally {
      await check.close();
      await fresh.drop();
    }
  });
});
