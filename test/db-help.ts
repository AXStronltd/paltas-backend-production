/* ====================================================================== *
 * TURNING A POSTGRES ERROR INTO AN INSTRUCTION.
 *
 * `code: 28000, routine: InitializeSessionUserId` is a precise, useful
 * message — to somebody who already knows that 28000 is
 * invalid_authorization_specification and that InitializeSessionUserId is
 * the function that resolves a role name. To everybody else it is noise,
 * and the natural response to it is to start changing the data model,
 * which is the one thing that cannot possibly help.
 *
 * So the common failures are named here with what to actually do.
 * ====================================================================== */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Hide the password before a connection string goes anywhere near a log. */
export function redact(url: unknown): string {
  return String(url || "").replace(/(:\/\/[^:/@]+):[^@]*@/, "$1:****@");
}

/** The role a connection string asks for, and the database it wants. */
/** What a connection string is asking for. */
export interface ConnectionParts {
  readonly role: string;
  readonly database: string;
  readonly host: string;
  readonly port: string;
  /** Whether one was given at all — never the password itself. */
  readonly hasPassword: boolean;
}

export function parts(url: unknown): ConnectionParts {
  try {
    const u = new URL(String(url));
    return {
      role: decodeURIComponent(u.username || "") || "(none given)",
      database: u.pathname.replace(/^\//, "") || "(none given)",
      host: u.hostname,
      port: u.port || "5432",
      hasPassword: Boolean(u.password),
    };
  } catch (e) {
    return { role: "?", database: "?", host: "?", port: "?", hasPassword: false };
  }
}

/**
 * What went wrong, and what to do about it.
 *
 * Returns null when the error is not one of the known configuration
 * failures — a real bug should not be dressed up as a setup problem.
 */
/**
 * WHAT POSTGRES ACTUALLY SAID.
 *
 * `pg` throws an Error carrying `code` and `routine` — its own SQLSTATE and
 * the internal function that failed — and neither is on the built-in Error.
 * Named here rather than read off `any`, because which one is set is how
 * this file tells a missing role from a missing database.
 */
export interface PostgresError extends Error {
  readonly code?: string;
  readonly routine?: string;
}

/** Is this the shape `pg` throws? */
const isPgError = (e: unknown): e is PostgresError =>
  e instanceof Error;

export function explain(raw: unknown, url: unknown): string | null {
  /* Nothing below can say anything useful about a throw that is not an
     Error — a real bug must not be dressed up as a setup problem. */
  if (!isPgError(raw)) return null;
  const err = raw;
  const p = parts(url);
  const where = `${p.host}:${p.port}`;

  /* 28000 — invalid_authorization_specification. The routine says which
     half failed, and InitializeSessionUserId is always the role name. */
  if (err.code === "28000") {
    return [
      `PostgreSQL refused the connection: the role "${p.role}" does not exist on ${where}.`,
      ``,
      `This is a CONFIGURATION problem, not a schema problem. Nothing in the`,
      `data model can fix it, and changing the schema to make it go away will`,
      `only hide it.`,
      ``,
      `Set TEST_DATABASE_URL to a role that exists. To see which do:`,
      ``,
      `    psql -h ${p.host} -p ${p.port} -l`,
      ``,
      `Two things that commonly cause it on a Mac:`,
      ``,
      `  1. Homebrew and Postgres.app create a superuser named after your macOS`,
      `     account — "${process.env.USER || "yourname"}" — and NOT "postgres".`,
      `     So a URL copied from a tutorial fails on a perfectly good database.`,
      `     Try:  postgresql://${process.env.USER || "yourname"}@127.0.0.1:5432/postgres`,
      ``,
      `  2. Something else is already listening on 5432, so the Docker container`,
      `     never started and you are talking to a different Postgres entirely.`,
      `     Check:  docker ps   and   lsof -i :5432`,
      ``,
      `To create the role instead:`,
      ``,
      `    createuser -h ${p.host} -p ${p.port} -s ${p.role === "(none given)" ? "paltas" : p.role}`,
    ].join("\n");
  }

  /* 28P01 — the role exists, the password is wrong. A different fix. */
  if (err.code === "28P01") {
    return [
      `PostgreSQL refused the password for role "${p.role}" on ${where}.`,
      ``,
      p.hasPassword
        ? `The role exists; the password in TEST_DATABASE_URL is wrong.`
        : `TEST_DATABASE_URL has NO password, and this server wants one.`,
      `Note the difference from 28000: there, the role did not exist at all.`,
    ].join("\n");
  }

  /* 3D000 — the server is fine, the database is not there. */
  if (err.code === "3D000") {
    return [
      `Connected to ${where} as "${p.role}", but there is no database called "${p.database}".`,
      ``,
      `    createdb -h ${p.host} -p ${p.port} ${p.database}`,
    ].join("\n");
  }

  if (err.code === "ECONNREFUSED") {
    return [
      `Nothing is listening on ${where}.`,
      ``,
      `    docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev --name paltas-pg postgres:16`,
      ``,
      `If that says the port is in use, a Postgres is already running — use that`,
      `one, and remember its role is probably "${process.env.USER || "yourname"}", not "postgres".`,
    ].join("\n");
  }

  if (err.code === "ENOTFOUND") {
    return `The host "${p.host}" does not resolve. Check TEST_DATABASE_URL.`;
  }

  return null;
}

/** Wrap a connection attempt so the failure explains itself. */
/** Only what this helper calls. `pg.Client` satisfies it. */
export interface Connectable {
  connect(): Promise<void>;
}

/**
 * A configuration failure, dressed as one.
 *
 * `configuration: true` is what the runner reads to decide between "your
 * setup is wrong" and "the product is broken".
 */
export interface ConfigurationError extends Error {
  code?: string;
  configuration?: boolean;
}

export async function connectOrExplain<T extends Connectable>(
  client: T, url: unknown,
): Promise<T> {
  try {
    await client.connect();
    return client;
  } catch (err) {
    const help = explain(err, url);
    if (!help || !isPgError(err)) throw err;
    const e: ConfigurationError = new Error(
      "\n\n" + "─".repeat(72) + "\n" + help + "\n" + "─".repeat(72) +
      `\n\nTEST_DATABASE_URL = ${redact(url)}\n` +
      `(postgres said: ${err.code} ${err.routine || ""} — ${err.message})\n`
    );
    e.code = err.code;
    e.configuration = true;
    throw e;
  }
}

/* ====================================================================== *
 * ONE SCHEMA PER TEST FILE.
 *
 * Every file here that needs a database rebuilds it from nothing, because a
 * test that depends on what the last run left behind is a test that passes
 * once. Four files doing that to `public` is a different problem entirely:
 * `node --test` runs FILES IN PARALLEL, so one file's DROP SCHEMA deletes
 * the tables another file is halfway through using.
 *
 * The failures then land everywhere except the file that caused them — 83
 * of them, saying things like `relation "Promotion" does not exist`, and
 * not one of them a bug in the product. It reads exactly like the schema is
 * broken, which is the worst possible way for a test harness to fail.
 *
 * So each file works inside a schema of its own and they stop colliding.
 * Serialising the suite would also have made it pass, and would have been
 * the wrong fix: it hides the sharing rather than removing it, and every
 * future run pays for it in wall-clock time.
 * ====================================================================== */

/** The DATABASE_URL Prisma needs in order to work inside one schema. */
export function urlForSchema(url: unknown, schema: string): string {
  const u = new URL(String(url));
  u.searchParams.set("schema", schema);
  return u.toString();
}

/**
 * A pool whose every connection resolves names inside `schema`.
 *
 * Passed as `options` rather than run as `SET search_path` after
 * connecting, because a Pool opens connections lazily and replaces them:
 * anything set on one connection is not true of the next one handed out.
 */
/**
 * Only what this file uses of `pg`, and of what it hands back.
 *
 * The package is imported dynamically by each caller — `await import("pg")` —
 * so there is no value here to infer a type from, and naming the two methods
 * is more useful than naming the package.
 */
export interface PgPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface PgModule {
  Pool: new (options: { connectionString: unknown; options?: string }) => PgPool;
}

export function poolInSchema(pg: PgModule, url: unknown, schema: string): PgPool {
  return new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
}

/** Empty `schema`, then apply every migration into it in Prisma's order. */
export async function freshSchema(pool: PgPool, schema: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`);
  const root = join(HERE, "..", "prisma", "migrations");
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, "migration.sql");
    if (!existsSync(file)) continue;
    try {
      await pool.query(readFileSync(file, "utf8"));
    } catch (e) {
      /* Which file, and where in it. A bare syntax error against 800 lines
         of concatenated SQL is a scavenger hunt. `position` is postgres's
         own character offset and is on nothing the language declares. */
      const said = e instanceof Error ? e.message : String(e);
      const at = (e as { position?: string | number } | null)?.position;
      throw new Error(
        `migration ${dir} failed: ${said}` +
        (at ? `\n  (at character ${at})` : ""));
    }
  }
}
