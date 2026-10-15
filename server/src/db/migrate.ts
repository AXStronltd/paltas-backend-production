/*
 * Applies the numbered SQL files in server/migrations/ in order, exactly once, all in ONE transaction: either every
 * pending migration is applied or none is.
 * An applied migration must never be edited: its checksum is stored and a changed file stops start-up.
 * Add a change as a NEW file (e.g. 0004_add_x.sql). A lock stops two servers migrating at the same time.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const LOCK_KEY = 7_240_811; // any constant; identifies "PALTAS migrations" for pg_advisory_lock

export async function migrate(db: Database): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await db.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await t.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await t.rows<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const version = file.replace(/\.sql$/, "");
      const had = done.get(version);
      if (had) {
        if (had !== sum)
          throw new Error(`Migration ${file} was changed after it was applied — add a new migration instead`);
        continue;
      }
      await t.run(sql);
      await t.run("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [version, sum]);
      applied.push(version);
    }
  });
  return applied;
}
