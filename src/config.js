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

const REQUIRED = [
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
function refuseLeakyNames(env) {
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

function read(env) {
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

  return {
    env: env.NODE_ENV || "development",
    port: Number(env.PORT) || 8080,

    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,

    publicUrl,
    appUrl,

    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      /* Whatever you register in Google Cloud must equal this string exactly,
         including the scheme and any trailing path. Google compares it
         character for character and the error it gives is famously unhelpful. */
      redirectUri: publicUrl + "/auth/google/callback",
    },

    /*
     * WHO MAY CALL THIS API FROM A BROWSER.
     *
     * An allow-list, never "*". The session is a cookie, so a wildcard origin
     * with credentials is the browser handing your session to any site that
     * asks. Extra origins (a staging URL, a local file server used for
     * testing) go in ALLOWED_ORIGINS, comma separated.
     */
    origins: [appUrl, ...String(env.ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean)],

    /* Cookies are cross-site the moment the API and the app are on different
       hostnames, which they are in every real deployment. SameSite=None then
       REQUIRES Secure, so this is on unless you are explicitly on http. */
    secureCookies: env.INSECURE_COOKIES !== "1",

    /* How long a sign-in lasts before the person signs in again. */
    sessionDays: Number(env.SESSION_DAYS) || 14,
  };
}

export const config = read(process.env);
export { read as readConfig };
