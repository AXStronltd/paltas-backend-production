/* ======================================================================
 * THE CLIENT LIST IS THE COMPANY'S OWN.
 *
 * Client 360 already read the server and said, correctly, "there is no
 * sample version of one" — then offered two buttons, "All clients" and
 * "Browse clients", to a screen reading a demo array. A company signing in
 * for the first time saw a list of strangers, opened one, and got a real
 * 360 of nobody.
 *
 * It also listed "Buyers" only. Parties share one table and nine kinds, so
 * a buyers-shaped list was the last place a tenant could hide from the
 * person looking for them.
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

function open(payload: unknown, { signedIn = true } = {}) {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8")
    + "\n;window.__S=SCREENS;window.__A=ACTIONS;", "console.js");
  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({ email: "a@b.c", name: "A Person", company: "Almas LTD",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT" });
  const asked: string[] = [];
  if (signedIn) {
    P.Data = { configured: () => true, create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      request: (path: string) => {
        asked.push(path);
        return payload === null
          ? Promise.reject(new Error("that did not load"))
          : Promise.resolve(payload);
      } };
  }
  return {
    asked, win: w.win as Record<string, any>,
    html: () => (w.win["__S"] as Record<string, () => string>)["pm_buyers"]!(),
    settle: async () => {
      (w.win["__S"] as Record<string, () => string>)["pm_buyers"]!();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

const TWO = { parties: [
  { id: "p1", name: "Grace Wanjiru", kind: "TENANT", email: "grace@example.com",
    phone: "+254700000001", since: "2026-01-04T00:00:00.000Z" },
  { id: "p2", name: "Mwangi Holdings", kind: "BUYER", email: "", phone: "" },
] };

test("it asks the server for the company's own contacts, once", { skip }, async () => {
  const c = open(TWO);
  await c.settle();
  /*
   * Not the only request on the page — the console boots into the command
   * centre, which asks for its own. What matters is that this screen asks
   * for parties, and asks once however many times it repaints.
   */
  assert.ok(c.asked.includes("/parties"), `never asked: ${c.asked.join(", ")}`);
  assert.equal(c.asked.filter((p) => p === "/parties").length, 1,
    "it asked more than once — a repaint must not re-fetch");
});

test("signed out, it offers no sample list at all", { skip }, async () => {
  const c = open(TWO, { signedIn: false });
  const html = c.html();
  assert.match(html, /There is no sample version of one/);
  /* The defect, named: demo people must not appear on a real screen. */
  assert.doesNotMatch(html, /Grace Wanjiru/);
});

test("a company with no clients is told so, and offered the action", { skip }, async () => {
  const c = open({ parties: [] });
  await c.settle();
  const html = c.html();
  assert.match(html, /Nobody on file yet/);
  assert.match(html, /data-act="newOpen"/);
});

test("every kind is listed, not only buyers", { skip }, async () => {
  const c = open(TWO);
  await c.settle();
  const html = c.html();
  assert.match(html, /Grace Wanjiru/);
  assert.match(html, /Mwangi Holdings/);
  assert.match(html, /tenant/, "a tenant must be visible on the client list");
  assert.match(html, /buyer/);
  assert.match(html, /<h1>Clients<\/h1>/, "it is a client list, not a buyers list");
});

test("each row opens the real 360 for that client", { skip }, async () => {
  const c = open(TWO);
  await c.settle();
  const html = c.html();
  assert.match(html, /data-act="clientOpen" data-arg="p1"/);
  assert.match(html, /data-act="clientOpen" data-arg="p2"/);
});

test("a failure is shown, never an empty list", { skip }, async () => {
  /*
   * The distinction the whole screen turns on: "nobody owes you anything"
   * and "we could not ask" must not look the same.
   */
  const c = open(null);
  await c.settle();
  const html = c.html();
  assert.match(html, /that did not load/);
  assert.doesNotMatch(html, /Nobody on file yet/);
});
