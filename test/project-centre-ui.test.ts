/* ======================================================================
 * ONE PROJECT — THE CONTROL CENTRE.
 *
 * The Development screen answers "how is the portfolio", across every project
 * at once. It could not answer "how is Golden Park Homes", which is the
 * question a developer actually asks.
 *
 * GET /projects/:id/report already assembled the answer — the programme, what
 * is blocking it, what has sold, the money where the role may see it, and who
 * is on the team. It had no screen. These hold the screen to showing that, and
 * to the report's own distinction between a figure of zero and a figure nobody
 * has recorded.
 * ====================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeWindow } from "./dom-shim.ts";

const FE = process.env.PALTAS_FRONTEND
  || resolve(process.cwd(), "..", "paltas-frontend 2");
const skip = existsSync(join(FE, "assets", "console.js"))
  ? false
  : `no frontend at ${FE} — set PALTAS_FRONTEND to run these`;

/** What GET /projects/:id/report returns for a running development. */
function golden(over: Record<string, unknown> = {}) {
  return {
    project: { id: "pj1", name: "Golden Park Homes", city: "Nairobi", currency: "KES" },
    programme: { recorded: true, progress: 62,
                 from: "the weighted average of its phases",
                 running: 2, done: 3,
                 milestones: { recorded: true, total: 8, pending: 3, missed: 1, overdue: 2 } },
    blockers: {
      rfis: { recorded: true, open: 4, overdue: 1 },
      permits: { recorded: true, granted: 5, blocking: 1, lapsed: 0 },
      defects: { recorded: true, critical: 1, major: 2, minor: 7 },
    },
    delivery: {
      units: { recorded: true, total: 250 },
      sales: { recorded: true, reserved: 12, sold: 172, completed: 160, cancelled: 3 },
      handovers: { recorded: true, booked: 6, done: 140, refused: 1 },
    },
    money: { currency: "KES",
             sales: { recorded: true, signed: "1360000000",
                      approvedVariations: "40000000", currentValue: "1400000000" },
             purchasing: { recorded: true, committed: "300000000", invoiced: "120000000" },
             appraisal: null },
    moneyVisible: true,
    team: { roles: [{ name: "A Person", role: "PROJECT_MANAGER", company: "Almas" }] },
    unrecorded: [],
    ...over,
  };
}

function open(report: unknown, { signedIn = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__P=function(){return PROJ;};",
    "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas It",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT" });
  const asked: string[] = [];
  if (signedIn) {
    P.Data = { configured: () => true, create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      request: (path: string) => {
        asked.push(path);
        if (path.endsWith("/activity")) return Promise.resolve({ events: [] });
        return report === null
          ? Promise.reject(new Error("that project could not be found"))
          : Promise.resolve(report);
      } };
  }
  return {
    asked, win: w.win as Record<string, any>,
    html: () => (w.win["__S"] as Record<string, () => string>)["pm_project"]!(),
    act: (k: string, a?: unknown) =>
      (w.win["__A"] as Record<string, (x?: unknown) => unknown>)[k]!(a),
    settle: async () => { await new Promise((r) => setTimeout(r, 5)); },
  };
}

test("opening a project asks for that project's report", { skip }, async () => {
  const c = open(golden());
  c.act("projOpen", "pj1");
  await c.settle();
  assert.ok(c.asked.includes("/projects/pj1/report"));
});

test("the header names the project and where it is", { skip }, async () => {
  const c = open(golden());
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /Golden Park Homes/);
  assert.match(html, /Nairobi · Project control centre/);
});

test("the figures are the report's, not the screen's", { skip }, async () => {
  const c = open(golden());
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /<b>250<\/b><span>Units/);
  assert.match(html, /<b>172<\/b><span>Sold/);
  assert.match(html, /<b>66<\/b><span>Available/, "250 less 172 sold and 12 reserved");
  assert.match(html, /<b>62%<\/b><span>Progress/);
});

/* Money is the project's own currency, and absent — not zero — without it. */
test("money is shown in the project's currency", { skip }, async () => {
  const c = open(golden());
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /KES 13,600,000/, "signed");
  assert.match(html, /KES 14,000,000/, "current value");
  assert.match(html, /KES 3,000,000/, "committed");
});

test("a role without finance sees the project but not its money", { skip }, async () => {
  const c = open(golden({ money: null, moneyVisible: false }));
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /Money is not shown on this account/);
  assert.doesNotMatch(html, /Signed<\/span>/);
  assert.match(html, /<b>250<\/b><span>Units/, "the rest of the project is still there");
});

/*
 * THE DISTINCTION THE REPORT MAKES, AND THE SCREEN MUST KEEP.
 * A project with no phases has no progress — not 0%.
 */
test("a figure nobody has recorded is a dash, never a nought", { skip }, async () => {
  const c = open(golden({
    programme: { recorded: false, progress: null, from: "no phases recorded",
                 running: 0, done: 0, milestones: { recorded: false } },
    delivery: { units: { recorded: false, total: 0 },
                sales: { recorded: false }, handovers: { recorded: false } },
  }));
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /<b>—<\/b><span>Progress/, "no phases means no progress, not 0%");
  assert.match(html, /<b>—<\/b><span>Units/);
  assert.match(html, /no phases recorded/);
  assert.match(html, /Nothing has been sold yet/);
  assert.doesNotMatch(html, /<b>0%<\/b><span>Progress/);
});

test("what is not set up is listed in the server's own words", { skip }, async () => {
  const c = open(golden({
    unrecorded: ["no programme — progress is whatever was typed on the project"] }));
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /Not set up yet/);
  assert.match(html, /progress is whatever was typed/);
  assert.match(html, /These are not faults/);
});

test("what is holding it up is shown, with somewhere to go", { skip }, async () => {
  const c = open(golden());
  c.act("projOpen", "pj1");
  await c.settle();
  const html = c.html();
  assert.match(html, /4 open · 1 overdue/, "RFIs");
  assert.match(html, /5 granted · 1 blocking/, "approvals");
  assert.match(html, /1 critical · 2 major/, "defects");
  for (const go of ["pm_rfis", "pm_permits", "pm_defects", "pm_phases", "pm_handover"]) {
    assert.match(html, new RegExp(`data-go="${go}"`), `nothing goes to ${go}`);
  }
});

test("adding a unit opens the real unit form, on the screen that draws it",
  { skip }, async () => {
    const c = open(golden());
    c.act("projOpen", "pj1");
    await c.settle();
    /*
     * goAdd, not newOpen. This screen draws no newPanel(), so newOpen() set
     * NEW and then rendered a project centre with nowhere to put the form —
     * the button did nothing. The assertion was pinned to the broken call,
     * which is how it kept passing.
     */
    assert.match(c.html(), /data-act="goAdd" data-arg="units"/);
  });

test("with no project chosen it offers the list", { skip }, () => {
  const c = open(golden());
  assert.match(c.html(), /No project chosen/);
});

test("a refusal is shown in the server's words", { skip }, async () => {
  const c = open(null);
  c.act("projOpen", "pj1");
  await c.settle();
  assert.match(c.html(), /could not be found/);
});

/* The development list is the way in. */
test("the development list opens a project", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const dev = src.slice(src.indexOf("SCREENS.development ="),
                        src.indexOf("SCREENS.development =") + 4000);
  assert.match(dev, /data-act="projOpen" data-arg="\$\{esc\(x\.id\)\}"/,
    "the development list has no way to open a project");
});
