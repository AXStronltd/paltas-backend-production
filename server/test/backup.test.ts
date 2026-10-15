// Backup and restore drill: dump a database with financial records, damage it, restore into a fresh database and
// check every record and total. Production uses managed PostgreSQL backups with point-in-time recovery; this drill
// proves the procedure and the verification step locally. Skipped when pg_dump/pg_restore are not installed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUrl, dbUrl } from "./support/global-setup.js";
import { startServer, type TestServer } from "./support/test-server.js";

function tool(name: string): string | null {
  for (const p of [name, `/usr/lib/postgresql/16/bin/${name}`, `/usr/lib/postgresql/17/bin/${name}`]) {
    try {
      execFileSync(p, ["--version"], { stdio: "ignore" });
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
const pgDump = tool("pg_dump");
const pgRestore = tool("pg_restore");

describe.skipIf(!pgDump || !pgRestore)("backup and restore", () => {
  let S: TestServer;
  const restored = `paltas_test_restore_${process.pid}`;
  beforeAll(async () => (S = await startServer()));
  afterAll(async () => {
    await S.close();
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`);
    await a.end();
  });

  it("restores every journal, line, invoice and audit entry with identical totals", async () => {
    const { orgId, admin } = await S.newOrg({ name: "Backup Co", trial: false });
    const acc = await S.addMember(orgId, admin.api, "accountant");
    const fd = await S.addMember(orgId, admin.api, "finance_director");
    for (let i = 1; i <= 25; i++) {
      const j = await acc.api.ledger.createJournal({
        params: { orgId },
        body: {
          date: "2026-10-05",
          memo: `Entry ${i}`,
          lines: [
            { account: "1000", debitMinor: i * 100 },
            { account: "4000", creditMinor: i * 100 },
          ],
        },
      });
      await fd.api.ledger.approveJournal({ params: { orgId, journalId: j.id } });
    }
    await admin.api.subscriptions.buyAddon({ params: { orgId }, body: { module: "crm", confirm: "CONFIRM" } });
    const totals = async (q: (sql: string) => Promise<any[]>) => ({
      journals: (await q("SELECT count(*)::int AS n FROM journal_entries"))[0].n,
      lines: (
        await q(
          "SELECT count(*)::int AS n, sum(debit_minor)::bigint AS dr, sum(credit_minor)::bigint AS cr FROM journal_lines",
        )
      )[0],
      invoices: (await q("SELECT count(*)::int AS n, sum(total_minor)::bigint AS s FROM billing_invoices"))[0],
      audit: (await q("SELECT count(*)::int AS n FROM audit_log"))[0].n,
    });
    const before = await totals((sql) => S.sql(sql));

    const dir = mkdtempSync(join(tmpdir(), "paltas-backup-"));
    const file = join(dir, "paltas.dump");
    const source = S.app.ctx.config.databaseUrl;
    const t0 = Date.now();
    execFileSync(pgDump as string, ["--format=custom", "--file", file, source]);
    const backupMs = Date.now() - t0;

    // damage: remove the source database entirely
    await S.app.close();
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${restored}`);
    await a.end();

    const t1 = Date.now();
    execFileSync(pgRestore as string, ["--no-owner", "--dbname", dbUrl(restored), file]);
    const restoreMs = Date.now() - t1;

    const c = new pg.Client({ connectionString: dbUrl(restored) });
    await c.connect();
    const after = await totals(async (sql) => (await c.query(sql)).rows);
    // the restored ledger still enforces its rules
    await expect(c.query("UPDATE journal_entries SET memo = 'x'")).rejects.toThrow(/cannot be (changed|edited)/);
    await c.end();
    rmSync(dir, { recursive: true, force: true });
    expect(after).toEqual(before);
    console.log(JSON.stringify({ backupMs, restoreMs }));
  });
});
