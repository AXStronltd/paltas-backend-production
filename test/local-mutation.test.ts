/* ======================================================================
 * NO BUTTON MAY WRITE ONLY TO THIS TAB.
 *
 * The console holds its rows in arrays, and for most of them the server is
 * the owner: the hydrator empties the array and refills it from the API on
 * every load. A button that mutates one of those arrays instead of sending
 * the change produces the worst failure this product can have — the screen
 * agrees with the person using it, and nothing was saved. It reads as
 * working right up until the next paint.
 *
 * Three vectors reach that state, and all three are pinned here:
 *   amend()  changes a row in place
 *   post()   adds a row to the ledger
 *   CREATE   a client-side form table, reached by any button that does not
 *            declare its own action — which is the part nobody would guess
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

const SRC = () => readFileSync(join(FE, "assets", "console.js"), "utf8");

/* Exactly the attributes the global click handler bails on before it reaches
   the CREATE table. Kept in step with that handler by the test below. */
const DECLARED = ["data-act", "data-go", "data-sys", "data-mode", "data-tab",
                  "data-scope", "data-mkt", "data-nb", "data-plan", "data-ptab",
                  "data-adtab", "data-pait", "data-pgo"];

function boot(page: string, product: string, signedIn = false) {
  const w = makeWindow({ href: `https://paltas.io/dashboard/${page}.html` });
  w.win["PALTAS_BOOT"] = { system: page };
  w.loadCode(SRC() +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__CREATE=CREATE;window.__L=LEDGER;" +
    /*
     * ADOPT, then ASK.
     *
     * seedHotel() runs when the file loads, which is before this test can
     * create a session, so the sample folios carry whatever org was current
     * then — and hotelRows() filters every one of them out afterwards. The
     * action would return "no folio is open for that stay" and the test would
     * pass while reaching none of the code it is about.
     *
     * __ADOPT puts the sample folios in the signed-in org. __OWING then scopes
     * exactly as folioOf() does.
     */
    "\n;window.__ADOPT=function(){FOLIOS.forEach(function(f){f.org=orgNow();});};" +
    "\n;window.__OWING=function(){return (hotelRows(FOLIOS).find(function(f){return folioBalance(f)>0;})||{}).res;};",
    "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "A Co",
    products: [product], role: "OWNER", preferred: product });
  if (signedIn) {
    P.Data = { configured: () => true, create: () => Promise.resolve({}),
               update: () => Promise.resolve({}) };
  }
  return w;
}

const PAGES: [string, string][] = [
  ["property", "PROPERTY_MANAGEMENT"], ["agent", "AGENT_HOST"],
  ["hotel", "HOTEL_MANAGEMENT"], ["security", "SECURITY_MANAGEMENT"],
];

/**
 * THE AUDIT, AS A TEST.
 *
 * `ag_dash`'s "＋ Add a property" was found this way: it declared nothing, so
 * it fell through to CREATE and pushed a row into AG_PROPS — which the server
 * owns and refills from the `listings` slug. It is the landing screen for four
 * AGENT_HOST roles, so it was the first button an agent saw.
 */
test("no button falls through to the client-side CREATE table", { skip }, () => {
  const found: string[] = [];

  for (const [page, product] of PAGES) {
    const w = boot(page, product);
    const SCREENS = w.win["__S"] as Record<string, () => string>;
    const CREATE = w.win["__CREATE"] as Record<string, unknown>;

    for (const screen of Object.keys(SCREENS)) {
      let html = "";
      try { html = SCREENS[screen]!(); } catch { continue; }
      for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const attrs = m[1] || "";
        const label = (m[2] || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        if (!label || DECLARED.some((a) => attrs.includes(a))) continue;
        if (CREATE[screen + "|" + label]) found.push(`${page}/${screen}: "${label}"`);
      }
    }
  }

  assert.deepEqual(found, [],
    "these buttons open a form that saves nowhere:\n  " + found.join("\n  "));
});

/* A button that opens a form on a screen which never draws it is a button that
   does nothing at all — the failure mode of moving the action but not the panel. */
test("ag_dash both opens the property form and draws it", { skip }, () => {
  const s = SRC();
  const dash = s.slice(s.indexOf("SCREENS.ag_dash = "), s.indexOf("SCREENS.ag_props = "));
  assert.match(dash, /data-act="newOpen::ag_props"/, "the button declares the real form");
  assert.match(dash, /newPanel\("ag_props"\)/, "and the screen draws it");
});

/* If the click handler learns a new dispatch attribute and this list does not,
   the audit above goes quiet rather than failing — so the list is checked
   against the handler itself. */
test("the dispatch-attribute list still matches the click handler", { skip }, () => {
  const s = SRC();
  const handler = s.slice(s.indexOf('if (b.hasAttribute("data-act")'), s.indexOf("const label = (b.innerText"));
  for (const a of DECLARED) {
    assert.ok(handler.includes(a), `${a} is in this test but no longer in the handler`);
  }
  for (const m of handler.matchAll(/hasAttribute\("(data-[a-z]+)"\)/g)) {
    assert.ok(DECLARED.includes(m[1]!), `the handler checks ${m[1]} and this test does not`);
  }
});

/*
 * The folio is sample data — no adapter, and the console calls none of the
 * folio endpoints — but post() writes into LEDGER, which IS hydrated. Taking
 * money on a sample folio therefore put a phantom row into the real finance
 * screens and said it was "in the ledger".
 */
for (const action of ["hPay", "hPostCharge"] as const) {
  test(`${action} writes nothing to the ledger for a real company`, { skip }, () => {
    const w = boot("hotel", "HOTEL_MANAGEMENT", true);
    (w.win["__ADOPT"] as () => void)();
    const owing = (w.win["__OWING"] as () => string | undefined)();
    assert.ok(owing, "there is a folio that would otherwise have been posted to");
    const arg = action === "hPay" ? owing : `${owing}|fnb|500|Dinner`;
    const L = w.win["__L"] as unknown[];
    const before = L.length;
    (w.win["__A"] as Record<string, (a: unknown) => unknown>)[action]!(arg);
    assert.equal(L.length, before, "no row was added to the hydrated ledger");
  });
}

/* And the demo still works when there is no company behind it, because that is
   what the sample data is for. The folio is chosen by asking which one owes
   something rather than by naming one — the seed settles some of them, and a
   test that picked a settled folio would pass for the wrong reason. */
test("hPay still posts in the sample console, where nothing is owned", { skip }, () => {
  const w = boot("hotel", "HOTEL_MANAGEMENT", false);
  (w.win["__ADOPT"] as () => void)();
  const owing = (w.win["__OWING"] as () => string | undefined)();
  assert.ok(owing, "the sample data has a folio with something outstanding");
  const L = w.win["__L"] as unknown[];
  const before = L.length;
  (w.win["__A"] as Record<string, (a: unknown) => unknown>)["hPay"]!(owing);
  assert.ok(L.length > before, "the sample folio still takes a payment");
});

/* amend() is the only way to change a ledger row in place. Every call site is
   accounted for: one, in the sample folio, behind the guard above. */
test("amend() has no unaudited call sites", { skip }, () => {
  const s = SRC();
  const calls = [...s.matchAll(/(?<![.\w])amend\(/g)]
    .map((m) => s.slice(0, m.index).split("\n").length)
    .filter((line) => {
      const text = s.split("\n")[line - 1] || "";
      return !/^\s*(\*|\/\/|\/\*)/.test(text) && !/^function amend/.test(text);
    });
  assert.equal(calls.length, 1,
    `amend() is called on ${calls.length} lines (${calls.join(", ")}); ` +
    "each one writes only to this tab and must be checked against test/local-mutation.test.ts");
});
