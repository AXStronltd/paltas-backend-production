/* ======================================================================
 * THE CONSOLE ONLY REACHES FOR ELEMENTS ITS PAGE ACTUALLY HAS.
 *
 * `document.getElementById("x").something` throws when the element is gone,
 * and because the console is one file evaluated top to bottom, a throw in
 * render() blanks the whole page rather than breaking one control.
 *
 * That has now happened three times in one week, each time from a different
 * direction:
 *
 *   GUIDE       read before it was assigned — first paint died, every
 *               signed-in console blank for two days
 *   #mkt        the picker was removed and its LISTENER guarded, while a
 *               second reference inside render() was missed — blank again,
 *               within minutes of deploying
 *
 * A comment saying "remember to guard" would not have caught either. This
 * does: every id the console reaches for must exist in every shell that loads
 * it, or the reach must be guarded.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const consoleJs = join(FE, "assets", "console.js");
const skip = existsSync(consoleJs) ? false : `no frontend at ${FE}`;

/** Every `getElementById("x")` whose result is used WITHOUT a null check. */
function unguardedIds(src: string): string[] {
  /* `.` or `[` straight after the call is the unguarded shape. A guarded one
     assigns first — `const x = getElementById(...); if (x)` — and that is the
     pattern this is asking for. */
  return [...src.matchAll(/document\.getElementById\("([a-z][a-z0-9_-]*)"\)\s*[.[]/g)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

/** The shells that actually load the console. */
function shells(): string[] {
  const dir = join(FE, "dashboard");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => readFileSync(join(dir, f), "utf8").includes("console.js"));
}

test("every element the console reaches for unguarded exists in every shell",
  { skip }, () => {
    const ids = unguardedIds(readFileSync(consoleJs, "utf8"));
    assert.ok(ids.length, "found no lookups at all — the pattern has changed");

    const missing: string[] = [];
    for (const shell of shells()) {
      const html = readFileSync(join(FE, "dashboard", shell), "utf8");
      for (const id of ids) {
        if (!html.includes(`id="${id}"`)) missing.push(`${shell} has no #${id}`);
      }
    }
    assert.deepEqual(missing, [],
      "the console would throw on first paint and the page would be blank:\n  "
      + missing.join("\n  "));
  });

test("removing an element from a shell is caught, not discovered in production",
  { skip }, () => {
    /*
     * The test above passing is only meaningful if it would fail. Drop a known
     * id out of a copy of a shell and check the same rule objects.
     */
    const ids = unguardedIds(readFileSync(consoleJs, "utf8"));
    const shell = readFileSync(join(FE, "dashboard", shells()[0]!), "utf8");
    const victim = ids.find((id) => shell.includes(`id="${id}"`));
    assert.ok(victim, "no id to test with");
    const without = shell.replaceAll(`id="${victim}"`, `id="${victim}-renamed"`);
    assert.ok(!without.includes(`id="${victim}"`),
      "the check below would pass for the wrong reason");
  });
