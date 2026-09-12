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
import { join } from "node:path";

const DOCKERFILE = readFileSync("Dockerfile", "utf8");

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

test("the blueprint does not deploy on a push, and says so", () => {
  /*
   * autoDeploy: false is deliberate, and it is also the thing that makes a
   * push look like nothing happened. Asserting it here means the next person
   * to wonder why finds the answer in a test rather than in Render's UI.
   */
  if (!existsSync("render.yaml")) return;
  const yaml = readFileSync("render.yaml", "utf8");
  assert.match(yaml, /autoDeploy:\s*false/,
    "render.yaml no longer sets autoDeploy: false. If that is intended, this test " +
    "should change with it — but a push that deploys itself is a decision, not a " +
    "default.");
  assert.match(yaml, /healthCheckPath:\s*\/health/,
    "the service must declare a health check, or Render will route traffic to a " +
    "container that has not finished starting");
  /* Secrets are entered by a person in the dashboard. */
  assert.doesNotMatch(yaml, /GOOGLE_CLIENT_SECRET:\s*\n?\s*value:/,
    "a secret has a literal value in render.yaml");
});
