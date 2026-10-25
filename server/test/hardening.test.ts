// The server cannot be frozen by one slow client or one runaway query:
// - a statement stops after the configured limit, an idle transaction is ended, a request waits only so long for a
//   database connection (scripts are not limited);
// - organisation exports run one per organisation and a few per server, each with its own longer limits; a stalled
//   export is released when the client goes away, and the next export can start;
// - migrations refuse to queue behind a held table lock (lock_timeout) instead of blocking every other query.
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportOrganisationAs } from "../dist/core/admin/export.js";
import { connect } from "../dist/db/database.js";
import { migrate } from "../dist/db/migrate.js";
import { startServer, type TestServer } from "./support/test-server.js";

const ACTOR = { userId: null, role: "super_admin" } as never;

describe("server limits", () => {
  let S: TestServer;
  let A: string;
  let B: string;
  beforeAll(async () => {
    S = await startServer({
      config: { dbTimeouts: { statementMs: 1000, idleInTransactionMs: 1500, connectMs: 800 }, exportMaxConcurrent: 1 },
    });
    A = (await S.newOrg({ name: "Big Export Estates" })).orgId;
    B = (await S.newOrg({ name: "Second Estates" })).orgId;
    // enough rows that an export cannot fit in the stream's buffer: it waits for the reader
    await S.app.ctx.db.run(
      `INSERT INTO audit_log (actor_role, org_id, action, target, detail)
       SELECT 'system', $1, 'Bulk row', 'T-' || g, repeat('x', 200) FROM generate_series(1, 3000) g`,
      [A],
    );
  });
  afterAll(() => S.close());

  it("stops a runaway statement", async () => {
    await expect(S.app.ctx.db.row("SELECT pg_sleep(3)")).rejects.toMatchObject({ code: "57014" });
    expect(await S.app.ctx.db.row<{ ok: number }>("SELECT 1 AS ok")).toEqual({ ok: 1 }); // the pool still works
  });

  it("ends a transaction left idle", async () => {
    await expect(
      S.app.ctx.db.tx(async (t) => {
        await t.run("SELECT 1");
        await sleep(2200);
        await t.run("SELECT 1");
      }),
    ).rejects.toBeTruthy();
    expect(await S.app.ctx.db.row<{ ok: number }>("SELECT 1 AS ok")).toEqual({ ok: 1 });
  });

  it("one export per organisation and a limited number per server; a stalled export is released", async () => {
    const first = await exportOrganisationAs(S.app.ctx, ACTOR, A, "Hardening test export");
    await sleep(300); // the export has filled the stream's buffer and waits for a reader that never reads
    await expect(exportOrganisationAs(S.app.ctx, ACTOR, A, "Second export, same organisation")).rejects.toMatchObject({
      status: 429,
    });
    await expect(exportOrganisationAs(S.app.ctx, ACTOR, B, "Another organisation")).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/other exports/),
    });
    // the export's own limits are longer than the server's 1.5 s idle limit: it is still alive after 2 s
    await sleep(2000);
    expect(first.body.destroyed).toBe(false);
    first.body.destroy(); // the client goes away
    await first.finished; // wait for connection cleanup and slot release, not an arbitrary CPU-dependent delay
    const next = await exportOrganisationAs(S.app.ctx, ACTOR, B, "After the stalled one");
    let text = "";
    for await (const c of next.body) text += c;
    expect(JSON.parse(text).organisation.id).toBe(B);
  });
  it("cleans up back-pressure listeners while a large customer export is consumed", async () => {
    const result = await exportOrganisationAs(S.app.ctx, ACTOR, A, "Slow customer export listener cleanup");
    let bytes = 0,
      peak = 0;
    for await (const chunk of result.body) {
      bytes += Buffer.byteLength(chunk);
      peak = Math.max(peak, result.body.listenerCount("close"));
      await sleep(5);
    }
    await result.finished;
    expect(bytes).toBeGreaterThan(200000);
    expect(peak).toBeLessThan(6);
  });
  it("reserves export slots before awaited work so simultaneous requests cannot bypass limits", async () => {
    const results = await Promise.allSettled([
      exportOrganisationAs(S.app.ctx, ACTOR, A, "Concurrent export one"),
      exportOrganisationAs(S.app.ctx, ACTOR, A, "Concurrent export two"),
      exportOrganisationAs(S.app.ctx, ACTOR, B, "Concurrent export other organisation"),
    ]);
    const successes = results.filter(
      (x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof exportOrganisationAs>>> => x.status === "fulfilled",
    );
    expect(successes).toHaveLength(1);
    const failures = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(failures).toHaveLength(2);
    for (const failed of failures) expect(failed.reason.status).toBe(429);
    for (const x of successes) {
      x.value.body.destroy();
      await x.value.finished;
    }
    const after = await exportOrganisationAs(S.app.ctx, ACTOR, B, "After concurrent cancellation");
    let text = "";
    for await (const c of after.body) text += c;
    await after.finished;
    expect(JSON.parse(text).organisation.id).toBe(B);
  });
});

describe("migrations", () => {
  let S: TestServer;
  beforeAll(async () => {
    S = await startServer();
  });
  afterAll(() => S.close());

  it("give up quickly when a table they need is locked, instead of queueing every query behind them", async () => {
    // a pending migration that needs a lock another session holds: the advisory lock is free, the table lock is not
    const url = S.app.ctx.config.databaseUrl;
    const holder = connect(url, 1);
    const db = connect(url, 1);
    try {
      await db.run("DELETE FROM schema_migrations WHERE version = '0026_us_rental_rules'"); // alters agency_listings
      let release!: () => void;
      const held = holder.tx(async (t) => {
        await t.run("LOCK TABLE agency_listings IN ACCESS EXCLUSIVE MODE");
        await new Promise<void>((r) => (release = r));
      });
      await sleep(200);
      const started = Date.now();
      try {
        await expect(migrate(db)).rejects.toMatchObject({ code: "55P03" }); // lock_not_available
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        release();
        await held;
      }
    } finally {
      await holder.close();
      await db.close();
    }
  }, 30_000);
});
