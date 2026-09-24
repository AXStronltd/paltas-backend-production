/* ====================================================================== *
 * CONFIGURATION.
 *
 * Every value this service needs, read once, in one place, and checked at
 * boot. A service that starts happily and then fails on the first sign-in
 * because a variable was misspelt is worse than one that refuses to start:
 * the first you find in production, the second you find in the deploy log.
 *
 * NOTHING SECRET IS EVER WRITTEN DOWN HERE. Values come from the environment
 * — Render's dashboard, or a local .env you keep out of git. `.env.example`
 * lists the names and no values at all, deliberately.
 * ====================================================================== */

/**
 * THE ENVIRONMENT, AS A SHAPE RATHER THAN A BAG OF STRINGS.
 *
 * `process.env` is `Record<string, string | undefined>`, and every value in
 * it is either absent or text — never a number, never a boolean, whatever it
 * looks like. Naming that here is what makes the coercions below visible:
 * `Number(env.SESSION_DAYS) || 14` is not defensive programming, it is the
 * only way to get a number out of this.
 */
export type Env = Record<string, string | undefined>;

/**
 * Everything this service needs to run, after it has been read and checked.
 *
 * Deliberately a type rather than an interface: it is the exact shape `read()`
 * returns, and nothing should be able to declare a second, subtly different
 * version of it somewhere else.
 */
export interface Config {
  readonly env: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly publicUrl: string;
  readonly appUrl: string;
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    /** Must equal what is registered in Google Cloud, character for character. */
    readonly redirectUri: string;
    /** Derived from PUBLIC_URL, because getting it wrong breaks sign-in silently. */
    readonly cookiePath: string;
  };
  /** An allow-list, never "*" — the session is a cookie. */
  readonly origins: readonly string[];
  readonly secureCookies: boolean;
  readonly sameOrigin: boolean;
  readonly cookieSameSite: string;
  readonly trustProxyHops: number;
  readonly sessionDays: number;
}

const REQUIRED: ReadonlyArray<readonly [name: string, why: string]> = [
  ["DATABASE_URL",
   "The Postgres connection string. On Render this is the INTERNAL URL of the database this service owns."],
  ["SESSION_SECRET",
   "A long random string used to sign session cookies. Generate one with: openssl rand -base64 48"],
  ["GOOGLE_CLIENT_ID",
   "From Google Cloud console → Credentials → OAuth 2.0 Client ID (Web application)."],
  ["GOOGLE_CLIENT_SECRET",
   "From the same credential. Never put this in a file that git can see."],
  ["PUBLIC_URL",
   "Where this API is reachable, e.g. https://api.paltas.io. Google redirects back here."],
  ["APP_URL",
   "Where the frontend lives, e.g. https://paltas.io. Sign-in returns the person here."],
];

/*
 * A NOTE ON NAMING, BECAUSE IT HAS BITTEN THIS PROJECT BEFORE.
 *
 * Nothing here may be prefixed NEXT_PUBLIC_. That prefix means "compile this
 * value into the JavaScript every visitor downloads", so a secret carrying it
 * is not a secret. This service refuses to start if it finds one, rather than
 * trusting that nobody will ever add one.
 */
function refuseLeakyNames(env: Env): void {
  const leaked = Object.keys(env).filter(
    (k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|KEY|TOKEN|PASSWORD|DATABASE/i.test(k)
  );
  if (leaked.length) {
    throw new Error(
      "These variables are named as if they were public but hold secrets: " +
      leaked.join(", ") +
      ". A NEXT_PUBLIC_ value is compiled into the browser bundle. Rename them and rotate the values."
    );
  }
}

/*
 * THE ORIGINS THIS PLATFORM IS ACTUALLY DEPLOYED ON.
 *
 * APP_URL covers wherever the frontend is configured to live, and
 * ALLOWED_ORIGINS covers whatever somebody adds later. Both are environment
 * settings, which means both can be wrong or missing in a dashboard nobody
 * has opened — and a missing origin does not fail loudly. It fails as a CORS
 * error in one browser, on one deployment, for one person.
 *
 * These two are written down because they are facts about the deployment, not
 * preferences: the Netlify production site and the domain it is moving to.
 * Naming them here means the API answers both the moment it starts, and the
 * environment can still add more.
 *
 * STILL AN ALLOW-LIST, AND STILL NEVER "*". The session is a cookie, so a
 * wildcard with credentials hands it to whatever site asks. Adding two known
 * hostnames is the opposite of that.
 */
const PRODUCTION_ORIGINS = [
  "https://paltas.io",
  "https://www.paltas.io",
  "https://paltas-frontend.netlify.app",
];

/**
 * A value REQUIRED has already proved is there.
 *
 * `process.env.DATABASE_URL` is `string | undefined` however many times it has
 * been checked, because the check above is a runtime filter and the compiler
 * cannot follow it into this function. Casting the doubt away would work and
 * would also be a lie the day the two lists drift.
 *
 * So it checks again, cheaply, and the message names the real failure: not
 * "missing setting" — that was handled above with a helpful list — but the
 * specific mistake of reading a value nobody added to REQUIRED, which today
 * lets `undefined` into the config silently.
 */
function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${key} is read by config.ts and is not in its REQUIRED list, so nothing ` +
      `checked it at boot. Add it to REQUIRED with a sentence saying where to ` +
      `get it — otherwise a missing value reaches the service as undefined.`);
  }
  return value;
}

/** Same origin listed twice is one origin. Order is kept; first wins. */
function dedupe(list: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  return list
    .map((o) => String(o || "").trim().replace(/\/+$/, ""))
    .filter((o) => o !== "" && !seen.has(o) && (seen.add(o), true));
}

function read(env: Env): Config {
  refuseLeakyNames(env);

  const missing = REQUIRED.filter(([k]) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    const lines = missing.map(([k, why]) => `  ${k}\n      ${why}`).join("\n");
    throw new Error(
      `The API cannot start. ${missing.length} required setting(s) are missing:\n\n${lines}\n\n` +
      `Set them in Render → your service → Environment, or in a local .env file.\n` +
      `See .env.example for the full list.`
    );
  }

  const publicUrl = String(env.PUBLIC_URL).replace(/\/+$/, "");
  const appUrl = String(env.APP_URL).replace(/\/+$/, "");

  /*
   * Are they the same origin? `https://paltas.io/api` and `https://paltas.io`
   * are — the path does not change the origin, and that is exactly the
   * arrangement a Netlify proxy produces.
   */
  const sameOrigin = (() => {
    try {
      const a = new URL(publicUrl), b = new URL(appUrl);
      return a.protocol === b.protocol && a.host === b.host;
    } catch (e) { return false; }
  })();

  return {
    env: env["NODE_ENV"] || "development",
    port: Number(env["PORT"]) || 8080,

    databaseUrl: required(env, "DATABASE_URL"),
    sessionSecret: required(env, "SESSION_SECRET"),

    publicUrl,
    appUrl,

    google: {
      clientId: required(env, "GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
      /* Whatever you register in Google Cloud must equal this string exactly,
         including the scheme and any trailing path. Google compares it
         character for character and the error it gives is famously unhelpful. */
      redirectUri: publicUrl + "/auth/google/callback",

      /*
       * THE PATH THE PKCE COOKIE MUST BE SCOPED TO.
       *
       * This is derived, not written down, because getting it wrong breaks
       * sign-in completely and silently.
       *
       * PALTAS is served through a Netlify proxy: the browser asks for
       * https://paltas.io/api/auth/google, which is forwarded to this service
       * at /auth/google. The backend never sees the /api, but the BROWSER does
       * — and a cookie is only sent back on request paths that start with its
       * Path.
       *
       * Scoped to "/auth" it was never sent to /api/auth/google/callback, so
       * the callback found no verifier, refused, and bounced the person back to
       * the login screen they started on. Sign-in looked like a loop and no
       * account could be created.
       *
       * PUBLIC_URL already carries whatever prefix the browser sees, so the
       * prefix comes from there. No prefix (talking to Render directly) gives
       * "/auth", which is what it should be in that deployment.
       */
      cookiePath:
        (() => {
          try {
            const prefix = new URL(publicUrl).pathname.replace(/\/+$/, "");
            return (prefix || "") + "/auth";
          } catch {
            return "/auth";
          }
        })(),
    },

    /*
     * WHO MAY CALL THIS API FROM A BROWSER.
     *
     * An allow-list, never "*". The session is a cookie, so a wildcard origin
     * with credentials is the browser handing your session to any site that
     * asks. Extra origins (a staging URL, a local file server used for
     * testing) go in ALLOWED_ORIGINS, comma separated.
     */
    origins: dedupe([
      appUrl,
      ...PRODUCTION_ORIGINS,
      ...String(env.ALLOWED_ORIGINS || "")
        .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    ]),

    /* Secure unless something explicitly turns it off for local http. */
    secureCookies: env.INSECURE_COOKIES !== "1",

    /*
     * ── SAME-ORIGIN OR CROSS-SITE, AND WHY IT DECIDES THE COOKIE ────────
     *
     * If the app and this API answer on the same origin — which they do when
     * Netlify proxies /api/* through to Render — the session cookie is
     * FIRST-PARTY and `SameSite=Lax` is correct.
     *
     * If they are on different hostnames (paltas.io talking to
     * api.paltas.io) the cookie is THIRD-PARTY, which needs
     * `SameSite=None; Secure` — and Safari blocks third-party cookies
     * outright, Chrome is removing them, and Firefox partitions them. On that
     * setup sign-in works in your browser and silently fails on every iPhone,
     * with no error anywhere, because the cookie is simply never stored.
     *
     * So the shape of the deployment decides the cookie, and the service
     * works it out rather than being told twice and getting it wrong once.
     */
    sameOrigin,
    cookieSameSite: env.COOKIE_SAMESITE || (sameOrigin ? "lax" : "none"),

    /*
     * How many proxies sit in front of this service. Render is one. Netlify
     * proxying to Render is two.
     *
     * It matters because `req.ip` is what the rate limiter counts by: trust
     * too few hops and every request looks like it came from the proxy, so
     * one noisy visitor throttles everybody; trust too many and a caller can
     * spoof X-Forwarded-For and never be throttled at all.
     */
    trustProxyHops: Number(env.TRUST_PROXY_HOPS) || (sameOrigin ? 2 : 1),

    /* How long a sign-in lasts before the person signs in again. */
    sessionDays: Number(env.SESSION_DAYS) || 14,
  };
}

export const config: Config = read(process.env);
export { read as readConfig };
