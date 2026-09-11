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

/** Hide the password before a connection string goes anywhere near a log. */
export function redact(url) {
  return String(url || "").replace(/(:\/\/[^:/@]+):[^@]*@/, "$1:****@");
}

/** The role a connection string asks for, and the database it wants. */
export function parts(url) {
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
export function explain(err, url) {
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
export async function connectOrExplain(client, url) {
  try {
    await client.connect();
    return client;
  } catch (err) {
    const help = explain(err, url);
    if (!help) throw err;
    const e = new Error(
      "\n\n" + "─".repeat(72) + "\n" + help + "\n" + "─".repeat(72) +
      `\n\nTEST_DATABASE_URL = ${redact(url)}\n` +
      `(postgres said: ${err.code} ${err.routine || ""} — ${err.message})\n`
    );
    e.code = err.code;
    e.configuration = true;
    throw e;
  }
}
