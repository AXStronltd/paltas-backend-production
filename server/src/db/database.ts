/*
 * PostgreSQL access. Repositories write plain SQL with $1, $2 … placeholders and get typed rows back.
 *
 *   const user = await db.row<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
 *   await db.tx(async (t) => { … all statements in one transaction … });
 *
 * Column values come back as plain JSON-friendly types: bigint → number (refused if unsafe), numeric → number,
 * date → "YYYY-MM-DD", timestamptz → ISO string.
 */
import pg from "pg";

const { Pool, types } = pg;

// --- type parsers (process-wide; set once) ---
const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;
const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;
types.setTypeParser(INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`Integer ${v} is too large to handle safely`);
  return n;
});
types.setTypeParser(NUMERIC, (v) => Number(v));
types.setTypeParser(DATE, (v) => v);
types.setTypeParser(TIMESTAMPTZ, (v) => new Date(v).toISOString());
types.setTypeParser(TIMESTAMP, (v) => new Date(v + "Z").toISOString());

export interface Db {
  /** All rows. */
  rows<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** The first row, or null. */
  row<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  /** Run a statement; returns the number of rows affected. */
  run(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Run fn in one transaction. Inside a transaction, tx() simply reuses it. */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
}

export interface Database extends Db {
  close(): Promise<void>;
  /** Raw SQL with several statements (migrations only). */
  execScript(sql: string): Promise<void>;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
}

function wrap(q: Queryable, tx: Db["tx"]): Db {
  // without parameters, pg uses the simple protocol, which also allows several statements (migrations)
  const exec = (sql: string, params: readonly unknown[]) => q.query(sql, params.length ? [...params] : undefined);
  return {
    rows: async <T>(sql: string, params: readonly unknown[] = []) => (await exec(sql, params)).rows as T[],
    row: async <T>(sql: string, params: readonly unknown[] = []) =>
      ((await exec(sql, params)).rows[0] as T | undefined) ?? null,
    run: async (sql, params = []) => (await exec(sql, params)).rowCount ?? 0,
    tx,
  };
}

export function connect(url: string, poolSize = 10): Database {
  const pool = new Pool({
    connectionString: url,
    max: poolSize,
    ssl: /sslmode=(require|verify-full|verify-ca)/.test(url) ? { rejectUnauthorized: true } : undefined,
  });
  // An idle connection the database closes (restart, failover, a dropped test database) is discarded by the pool and
  // reported here; without a listener it would be an unhandled error that stops the process.
  let closing = false;
  pool.on("error", (err) => {
    if (!closing) console.warn(`PostgreSQL closed an idle connection: ${err.message}`);
  });

  async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const inner: Db = wrap(client, (f) => f(inner));
      const result = await fn(inner);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      // if even ROLLBACK fails the connection is unusable: hand it back as broken so the pool discards it
      await client.query("ROLLBACK").catch((rollbackError: Error) => {
        broken = rollbackError;
      });
      throw e;
    } finally {
      client.release(broken);
    }
  }

  return {
    ...wrap(pool, tx),
    // pool.end() resolves before its connections have finished closing: wait until every one is gone
    close: async () => {
      closing = true;
      const open = pool.totalCount;
      let removed = 0;
      const gone = new Promise<void>((resolve) => {
        if (!open) resolve();
        pool.on("remove", () => {
          if (++removed >= open) resolve();
        });
      });
      await pool.end();
      await gone;
    },
    execScript: async (sql) => {
      await pool.query(sql);
    },
  };
}
