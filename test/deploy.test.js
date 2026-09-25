/* ====================================================================== *
 * THE IMAGE THAT ACTUALLY SHIPS.
 *
 * Every other test in this repo runs against the working tree, where every
 * file exists. The container is a SUBSET — the Dockerfile copies package
 * manifests, prisma/, one contract file and src/ — and a file the server
 * reads at runtime but nobody copied is invisible to all of them.
 *
 * THIS IS NOT HYPOTHETICAL. src/domain/market.js reads
 * contract/market-config.js with readFileSync at IMPORT time, and the
 * Dockerfile did not copy it. The container could not start: importing
 * src/routes/market.js threw ENOENT before the process ever listened, Render
 * failed the deploy and kept the previous build, and from the outside that is
 * indistinguishable from "the push did nothing". Thirteen minutes of a healthy
 * old instance, and no clue why.
 *
 * A test that can be satisfied by the working tree would not have caught it.
 * So this one reads the Dockerfile.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
/* Source is read through one helper so a rename to .ts cannot make this
   scanner silently find nothing. See test/src-files.js. */
import { sourceText } from "./src-files.ts";

const DOCKERFILE = readFileSync("Dockerfile", "utf8");
const DOCKERIGNORE = existsSync(".dockerignore")
  ? readFileSync(".dockerignore", "utf8").split("\n")
  : [];

/** Every path the Dockerfile copies into the image. */
function copied() {
  const out = [];
  for (const m of DOCKERFILE.matchAll(/^COPY\s+(?!--from)(.+)$/gm)) {
    const parts = m[1].trim().split(/\s+/);
    parts.pop();                                  /* the destination */
    out.push(...parts);
  }
  return out;
}

/**
 * Is this path excluded from the build context?
 *
 * THE GAP THAT LET A SECOND BUILD FAIL.
 *
 * The test below checked the Dockerfile's COPY lines and passed, while the
 * build failed on the very line it had just approved:
 *
 *     COPY contract/market-config.js: "/contract/market-config.js": not found
 *
 * Because .dockerignore said `contract/`. The file was in the repository, in
 * git, and named in the Dockerfile — and never in the build context, so the
 * COPY had nothing to copy. A COPY of an ignored path is not a typo a reviewer
 * spots; it is two correct-looking files that contradict each other.
 *
 * Later patterns win, and a leading ! is an exception — the same precedence
 * Docker uses.
 */
function dockerIgnored(path) {
  let out = false;
  for (const raw of DOCKERIGNORE) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const neg = line.startsWith("!");
    const pat = (neg ? line.slice(1) : line).replace(/\/+$/, "");
    if (matches(path, pat)) out = !neg;
  }
  return out;
}

/** Glob matching, to the extent .dockerignore uses one: * and a path prefix. */
function matches(path, pat) {
  if (path === pat) return true;
  const rx = new RegExp("^" + pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*") + "(/.*)?$");
  return rx.test(path);
}

/** Walk src/ for every file. */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/* ================================================================ */

test("every file the server reads at runtime is copied into the image", () => {
  const inImage = copied();

  /*
   * A readFileSync with a path built from import.meta.url is a runtime file
   * dependency. Resolve the literal segments and check the Dockerfile carries
   * them — either by name, or because a directory above them is copied.
   */
  const reads = [];
  for (const file of walk("src")) {
    const text = readFileSync(file, "utf8");
    /* Only files that actually read from disk at runtime. */
    if (!/\breadFileSync\s*\(/.test(text)) continue;

    /*
     * The path is usually built a line above the read —
     * `const f = join(HERE, "..", "..", "contract", "market-config.js")` —
     * so looking only inside readFileSync(...) finds nothing. Collect the
     * literal segments of every join() and every new URL() in a file that
     * reads from disk.
     */
    for (const m of text.matchAll(/\bjoin\(([^)]*)\)/g)) {
      const segs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      if (segs.length) reads.push({ file, path: segs.join("/") });
    }
    for (const m of text.matchAll(/new URL\(\s*"([^"]+)"/g)) {
      reads.push({ file, path: m[1] });
    }
  }

  /* If this finds nothing the test proves nothing — it is reading source, and
     source changes shape. */
  assert.ok(reads.length >= 1,
    "found no runtime readFileSync in src/, so this test is no longer checking " +
    "anything — the pattern it looks for has changed");

  const missing = [];
  for (const r of reads) {
    /*
     * "../../contract/market-config.js" -> "contract/market-config.js".
     *
     * The segments are relative to the FILE, and every such path in src/
     * climbs back to the repository root before descending again — so
     * dropping the ".." segments gives the path as the Dockerfile writes it.
     */
    const wanted = r.path.split("/").filter((x) => x && x !== ".." && x !== ".").join("/");
    if (!wanted) continue;
    const covered = inImage.some((c) => {
      const cc = c.replace(/^\.\//, "");
      return wanted === cc || wanted.startsWith(cc.replace(/\/$/, "") + "/");
    });
    if (!covered) missing.push(`${r.file} reads ${wanted}`);
  }

  assert.deepEqual(missing, [],
    "the server reads these at runtime and the Dockerfile does not copy them, so " +
    "the container will not start — and Render will keep the previous build, which " +
    "looks like the push did nothing:\n  " + missing.join("\n  ") +
    "\nAdd a COPY line for each.");
});

test("the image copies what it needs and not the documentation", () => {
  const inImage = copied().map((c) => c.replace(/^\.\//, ""));
  for (const need of ["prisma", "src", "package.json"]) {
    assert.ok(inImage.some((c) => c === need || c.startsWith(need)),
      `the Dockerfile does not copy ${need}`);
  }
  /* backend.md is 1,000 lines of prose about how the service works. It is for
     people reading the repository, not for the container. */
  assert.ok(!inImage.some((c) => /backend\.md$/.test(c) || c === "contract"),
    "the image copies the whole contract/ directory, which carries documentation " +
    "the running service has no use for. Copy the files it reads, by name.");
});

test("the image runs the compiled output, and never the source", () => {
  /*
   * THE INVARIANT THE MIGRATION ADDED.
   *
   * src/ is compiled to dist/ in a builder stage and only dist/ is copied
   * into the runtime image. Two things could quietly undo that: a start
   * command still pointing at src/server.js (which would then be missing, so
   * at least it fails loudly), or a runtime stage that copies src/ as well
   * (which would NOT fail — it would ship the source and the toolchain's
   * output side by side, and nobody could say which one was running).
   */
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts.start, /node dist\/server\.js/,
    "`npm start` must run the compiled server. Running src/server.js would mean " +
    "the build is decoration.");
  assert.ok(pkg.scripts.build, "there is no build script, so nothing produces dist/");

  /* The builder stage exists and actually compiles. */
  assert.match(DOCKERFILE, /FROM\s+\S+\s+AS\s+builder/i,
    "the Dockerfile has no builder stage, so the toolchain would ship in the " +
    "runtime image — and a layer is forever.");
  assert.match(DOCKERFILE, /RUN npm run build/,
    "the builder stage never runs the build");
  assert.match(DOCKERFILE, /COPY --from=builder \/app\/dist \.\/dist/,
    "the runtime stage does not take dist/ from the builder");

  /*
   * And the runtime stage copies no source. Checked by splitting on the stage
   * boundary rather than searching the whole file, because the BUILDER
   * legitimately copies src and a naive grep would read that as a violation.
   */
  const runtime = DOCKERFILE.slice(DOCKERFILE.search(/FROM\s+\S+\s+AS\s+runtime/i));
  assert.ok(runtime.length > 100, "no runtime stage found to check");
  assert.doesNotMatch(runtime, /^COPY\s+(?!--from)src\b/m,
    "the runtime image copies src/ as well as dist/. Both would be present and " +
    "nobody could say which one is running.");
  assert.doesNotMatch(runtime, /^COPY\s+(?!--from).*tsconfig/m,
    "the runtime image carries tsconfig.json, which it has no use for");
});

test("the start command migrates before it serves", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts.start, /prisma migrate deploy\s*&&/,
    "`npm start` must run `prisma migrate deploy` BEFORE the server, and with && " +
    "rather than ; — a failed migration must stop the deploy, not serve traffic " +
    "against a schema the code does not match");
  assert.doesNotMatch(pkg.scripts.start, /migrate (dev|reset)/,
    "`migrate dev` prompts and `migrate reset` DESTROYS DATA. Neither belongs in a " +
    "production start command.");
});

test("the blueprint deploys on a push, and declares a health check", () => {
  /*
   * autoDeploy: false is deliberate, and it is also the thing that makes a
   * push look like nothing happened. Asserting it here means the next person
   * to wonder why finds the answer in a test rather than in Render's UI.
   */
  if (!existsSync("render.yaml")) return;
  const yaml = readFileSync("render.yaml", "utf8");
  /*
   * autoDeploy is now TRUE, and this test changed with it rather than being
   * deleted. The requirement is that main deploys itself: three commits once sat
   * on main looking deployed while the service ran older code, and the first
   * manual deploy then failed on a Dockerfile fault nothing had ever exercised.
   *
   * A failed build leaves the previous instance serving, so the risk of
   * deploying automatically is smaller than the risk of not knowing what is
   * deployed.
   */
  assert.match(yaml, /autoDeploy:\s*true/,
    "render.yaml no longer auto-deploys. A push that does not deploy is a push " +
    "whose result nobody has seen — which is how an undeployed commit spends a " +
    "day looking live.");
  assert.match(yaml, /healthCheckPath:\s*\/health/,
    "the service must declare a health check, or Render will route traffic to a " +
    "container that has not finished starting");
  /* Secrets are entered by a person in the dashboard. */
  assert.doesNotMatch(yaml, /GOOGLE_CLIENT_SECRET:\s*\n?\s*value:/,
    "a secret has a literal value in render.yaml");
});

test("every path the Dockerfile copies is actually in the build context", () => {
  /*
   * A COPY and a .dockerignore that disagree is a build failure, not a warning:
   *
   *     COPY contract/market-config.js: "/contract/market-config.js": not found
   *
   * and the file is sitting right there in git. This is the test that would
   * have caught it before a deploy did.
   */
  const problems = [];
  for (const src of copied()) {
    const path = src.replace(/^\.\//, "");
    /* Wildcard sources (package-lock.json*) are allowed to match nothing. */
    if (path.includes("*")) continue;
    if (!existsSync(path)) {
      problems.push(`${path} is copied by the Dockerfile and does not exist`);
      continue;
    }
    if (dockerIgnored(path)) {
      problems.push(`${path} is copied by the Dockerfile and EXCLUDED by .dockerignore`);
    }
  }
  assert.deepEqual(problems, [],
    "the Dockerfile and .dockerignore contradict each other, so the build will " +
    "fail on a line that looks correct:\n  " + problems.join("\n  "));
});

test("every contract file is either excluded by name or the one the server reads", () => {
  /*
   * THE COST OF BEING EXPLICIT, PAID BY A TEST.
   *
   * .dockerignore names the contract files to keep out individually, because a
   * `!` exception inside an excluded directory behaves differently between
   * builders and a failed deploy had already cost time once. The price of that
   * certainty is that a NEW file in contract/ would ship silently.
   *
   * This is the test that stops it. Add a file to contract/ and either exclude
   * it or say it belongs in the image — but do it deliberately.
   */
  const keep = new Set(["market-config.js"]);
  const stowaways = [];
  for (const f of readdirSync("contract")) {
    const path = "contract/" + f;
    if (keep.has(f)) {
      assert.ok(!dockerIgnored(path),
        `${path} is what the server reads at runtime and it is excluded`);
      continue;
    }
    if (!dockerIgnored(path)) stowaways.push(path);
  }
  assert.deepEqual(stowaways, [],
    "these contract files would be shipped in the image and nobody decided that:\n  " +
    stowaways.join("\n  ") +
    "\nAdd each to .dockerignore, or add it to `keep` here with the reason it belongs.");
});

test(".dockerignore still keeps out the things that must never ship", () => {
  /*
   * Re-including one file from contract/ must not have re-included the rest,
   * and must certainly not have loosened .env or node_modules. Asserted by
   * name, because this is the file where a loosened pattern is invisible.
   */
  for (const path of [".env", ".env.local", "node_modules/x", "test/deploy.test.js",
                      "contract/backend.md", "contract/js43.js", ".git/config"]) {
    assert.ok(dockerIgnored(path), `${path} would now enter the build context`);
  }
  /* And the one exception still applies. */
  assert.ok(!dockerIgnored("contract/market-config.js"),
    "the file the server reads at runtime is excluded again");
  assert.ok(!dockerIgnored("src/server.js"), "src/ is excluded, which cannot be right");
});

test("API responses are not cacheable unless they are genuinely public", () => {
  /*
   * This service is proxied through paltas.io, so its responses pass through a
   * shared CDN. One customer's list sitting in that cache and being served to
   * another is exactly the wall this platform sells, and a MISSING
   * Cache-Control header leaves that to a heuristic.
   *
   * The default is set in server.js before the routers, so the handful of
   * genuinely public catalogue endpoints can override it — and only those.
   *
   * It cannot live in netlify.toml: headers there do not apply to proxied
   * responses, so the rule looked right and did nothing. That is why this test
   * reads server.js rather than the toml.
   */
  const server = sourceText("server.js");
  const idx = server.indexOf('res.set("Cache-Control", "no-store")');
  assert.notEqual(idx, -1,
    "server.js no longer sets a no-store default, so an authenticated response " +
    "can be cached by whatever the CDN decides");

  /* It has to come BEFORE the routers, or the public routes cannot override. */
  const firstRouter = Math.min(
    ...["marketRoutes", "guestRoutes", "platformRoutes", "productRoutes"]
      .map((r) => server.indexOf("app.use(" + r))
      .filter((i) => i > -1));
  assert.ok(idx < firstRouter,
    "the no-store default is registered after the routers, so the public " +
    "catalogue endpoints can no longer override it");

  /*
   * And the toml must not pretend to do it.
   *
   * FE is resolved here rather than borrowed: it is defined in
   * frontend-contract.test.js, and referencing it from this file threw
   * "FE is not defined" — a test that fails for its own reasons rather than the
   * code's.
   */
  const FRONTEND = process.env.PALTAS_FRONTEND
    || resolve(process.cwd(), "..", "paltas-frontend 2");
  if (existsSync(join(FRONTEND, "netlify.toml"))) {
    const toml = readFileSync(join(FRONTEND, "netlify.toml"), "utf8");
    const apiHeaderBlock = /\[\[headers\]\][\s\S]{0,200}for = "\/api\/\*"/.test(toml);
    assert.ok(!apiHeaderBlock,
      "netlify.toml has a [[headers]] block for /api/* — those do not apply to " +
      "proxied responses, so it does nothing while looking like protection");
  }
});
