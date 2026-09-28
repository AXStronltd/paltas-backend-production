/* ======================================================================
 * THE COLLECTIONS SCREEN SHOWS WHAT IS OWED.
 *
 * It used to read the merged cash list and filter `flow === "in"`. Every row
 * that survives that filter is a PAYMENT — money that has already arrived — so
 * Outstanding, Overdue, every aging bucket and every tenant balance rendered as
 * ZERO for real data, for every company. Its own closing note said "a
 * receivable is a transaction", which is the belief that produced the bug.
 *
 * It now asks GET /ledger/receivables, which derives arrears from each
 * invoice's own total and what has been received against it. These tests hold
 * the screen to that: real figures, per currency, with a way to take the money.
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

/** What the server returns. Minor units, as the API counts. */
function report(over: Record<string, unknown> = {}) {
  return {
    asAt: "2026-09-28T00:00:00.000Z",
    mixed: false,
    invoiceCount: 2,
    books: [{
      currency: "KES",
      open: "40000000", notYetDue: "10000000", overdue: "30000000",
      aging: [
        { bucket: "CURRENT", label: "Not yet due", count: 1, amount: "10000000" },
        { bucket: "DUE", label: "Due today", count: 0, amount: "0" },
        { bucket: "D1_30", label: "1 – 30 days", count: 0, amount: "0" },
        { bucket: "D31_60", label: "31 – 60 days", count: 1, amount: "30000000" },
        { bucket: "D61_90", label: "61 – 90 days", count: 0, amount: "0" },
        { bucket: "D90_PLUS", label: "Over 90 days", count: 0, amount: "0" },
      ],
      parties: [
        { partyId: "p1", name: "Grace Wanjiru", currency: "KES", open: "30000000",
          invoiceCount: 1, oldestDaysLate: 45, bucket: "D31_60" },
        { partyId: "p2", name: "Peter Kamau", currency: "KES", open: "10000000",
          invoiceCount: 1, oldestDaysLate: -6, bucket: "CURRENT" },
      ],
    }],
    invoices: [
      { invoiceId: "i1", ref: "INV-2026-0041", partyName: "Grace Wanjiru", currency: "KES",
        total: "30000000", paid: "0", open: "30000000",
        issuedOn: "2026-08-01T00:00:00.000Z", dueOn: "2026-08-14T00:00:00.000Z",
        daysLate: 45, bucket: "D31_60", status: "SENT", leaseId: null, contractId: null },
      { invoiceId: "i2", ref: "INV-2026-0042", partyName: "Peter Kamau", currency: "KES",
        total: "14000000", paid: "4000000", open: "10000000",
        issuedOn: "2026-09-20T00:00:00.000Z", dueOn: "2026-10-04T00:00:00.000Z",
        daysLate: -6, bucket: "CURRENT", status: "PART_PAID", leaseId: null, contractId: null },
    ],
    ...over,
  };
}

interface Opened {
  html: () => string;
  asked: string[];
  settle: () => Promise<void>;
  win: Record<string, any>;
}

/** The console, signed in, with /ledger/receivables answered from a fixture. */
function open(payload: unknown | null, { signedIn = true } = {}): Opened {
  const w = makeWindow({ href: "https://paltas.io/dashboard/property.html" });
  w.win["PALTAS_BOOT"] = { system: "property" };
  w.loadCode(readFileSync(join(FE, "assets", "console.js"), "utf8") +
    "\n;window.__S=SCREENS;window.__A=ACTIONS;window.__AR=function(){return AR;};",
    "console.js");

  const P = w.win["PALTAS"] as Record<string, any>;
  P.Session.create({
    email: "a@b.c", name: "A Person", company: "A Co",
    products: ["PROPERTY_MANAGEMENT"], role: "OWNER", preferred: "PROPERTY_MANAGEMENT",
  });

  const asked: string[] = [];
  if (signedIn) {
    P.Data = {
      configured: () => true,
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      request: (path: string) => {
        asked.push(path);
        return payload === null
          ? Promise.reject(new Error("The ledger is not open to this account"))
          : Promise.resolve(payload);
      },
    };
  }

  return {
    html: () => (w.win["__S"] as Record<string, () => string>)["fin_collect"]!(),
    asked,
    /* The screen asks on its first paint via setTimeout, so one paint plus a
       turn of the loop is what "loaded" looks like. */
    settle: async () => {
      (w.win["__S"] as Record<string, () => string>)["fin_collect"]!();
      await new Promise((r) => setTimeout(r, 5));
    },
    win: w.win as Record<string, any>,
  };
}

test("it asks the server what is owed, rather than reading the cash list", { skip }, async () => {
  const c = open(report());
  await c.settle();
  assert.ok(c.asked.some((p) => p.startsWith("/ledger/receivables")),
    `it never asked for receivables; it asked: ${JSON.stringify(c.asked)}`);
});

test("the real figures are on the screen, not zero", { skip }, async () => {
  const c = open(report());
  await c.settle();
  const html = c.html();

  /*
   * 40,000,000 minor units is KES 400,000, and the bug rendered 0 for all of
   * these. Two conventions are deliberate and both are asserted: a KPI tile
   * abbreviates to the nearest thousand so the largest figures stay readable,
   * and a table states the figure in full so it can be checked.
   */
  assert.match(html, /KES 400K<\/b><span>Outstanding/, "outstanding, as a KPI");
  assert.match(html, /KES 300K<\/b><span>Overdue/, "overdue, as a KPI");
  assert.match(html, /KES 100K<\/b><span>Not yet due/, "not yet due, as a KPI");
  assert.match(html, /KES 300,000/, "and in full in the tables");
  assert.match(html, /KES 100,000/);
  assert.doesNotMatch(html, /Nobody is in arrears/, "the old empty claim is gone");
});

test("who owes it, worst first, with how late they are", { skip }, async () => {
  const c = open(report());
  await c.settle();
  const html = c.html();
  assert.match(html, /Grace Wanjiru/);
  assert.match(html, /Peter Kamau/);
  assert.ok(html.indexOf("Grace Wanjiru") < html.indexOf("Peter Kamau"),
    "45 days late comes before something not yet due");
  assert.match(html, /45d/, "how late the worst account is");
});

test("each open invoice offers to take the money", { skip }, async () => {
  const c = open(report());
  await c.settle();
  const html = c.html();
  assert.match(html, /INV-2026-0041/);
  assert.match(html, /INV-2026-0042/);
  assert.match(html, /data-act="invPay::i1"/, "and a way to record a payment against it");
  assert.match(html, /data-act="invPay::i2"/);
});

/* A part-paid invoice must show all three numbers, or "still owing" cannot be
   checked against anything. */
test("a part-paid invoice shows invoiced, received and still owing", { skip }, async () => {
  const c = open(report());
  await c.settle();
  const html = c.html();
  assert.match(html, /KES 140,000/, "invoiced");
  assert.match(html, /KES 40,000/, "received");
});

/* The payment form must open from here too. Collections reads the receivables
   report, not the hydrated INVOICES array, so the form has to find it there. */
test("the payment form opens against an invoice from Collections", { skip }, async () => {
  const c = open(report());
  await c.settle();
  (c.win["__A"] as Record<string, (a: unknown) => unknown>)["invPay"]!("i1");
  const html = c.html();
  assert.match(html, /Record a payment against INV-2026-0041/);
  assert.match(html, /300,000 outstanding/, "defaulted to what that invoice owes");
});

test("two currencies are two books and never one total", { skip }, async () => {
  const two = report({
    mixed: true,
    books: [
      { ...report().books[0]!, currency: "KES" },
      { currency: "SEK", open: "5000000", notYetDue: "5000000", overdue: "0",
        aging: report().books[0]!.aging.map((a) => ({ ...a, count: 0, amount: "0" })),
        parties: [{ partyId: "p3", name: "Svensson AB", currency: "SEK", open: "5000000",
                    invoiceCount: 1, oldestDaysLate: -3, bucket: "CURRENT" }] },
    ],
  });
  const c = open(two);
  await c.settle();
  const html = c.html();
  assert.match(html, /Outstanding in KES/);
  assert.match(html, /Outstanding in SEK/);
  assert.match(html, /More than one currency is owed/);
  assert.match(html, /will not assume one/, "and it says nothing was converted");
});

test("nothing outstanding says so, and offers to raise an invoice", { skip }, async () => {
  const c = open(report({ books: [], invoices: [], invoiceCount: 0 }));
  await c.settle();
  const html = c.html();
  assert.match(html, /Nothing is outstanding/);
  assert.match(html, /newOpen/, "with somewhere to go next");
});

/*
 * A FAILURE MUST NOT LOOK LIKE NOBODY OWING ANYTHING. That is the one wrong
 * answer this screen can give, and the old version gave it permanently.
 */
test("a refusal is shown in the server's words, never as zero", { skip }, async () => {
  const c = open(null);
  await c.settle();
  const html = c.html();
  assert.match(html, /not open to this account/, "the server's own sentence");
  assert.doesNotMatch(html, /KES 0/);
  assert.doesNotMatch(html, /Nothing is outstanding/,
    "an error is not the same claim as nothing being owed");
});

test("signed out, it says so instead of showing a sample", { skip }, async () => {
  const c = open(report(), { signedIn: false });
  await c.settle();
  const html = c.html();
  assert.match(html, /Sign in to your company/);
  assert.doesNotMatch(html, /Grace Wanjiru/, "arrears that are not yours are not information");
});

/* The belief that caused the defect, pinned so it cannot come back. */
test("the screen no longer derives receivables from the cash list", { skip }, () => {
  const src = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const start = src.indexOf("SCREENS.fin_collect = () => {");
  const body = src.slice(start, src.indexOf("\n};\n", start));
  assert.doesNotMatch(body, /ledger\(/,
    "a payment is not a receivable — this screen must not read the merged cash list");
  assert.doesNotMatch(body, /A receivable is a transaction/,
    "the note that stated the defect as a principle is gone");
});

/* ======================================================================
 * NO INVENTED FINANCE FIGURES.
 *
 * Collection rates, arrears and operating costs were fabricated on three
 * screens — a flat 86.4% collection rate, arrears at 3.1% of rent, a literal
 * array of per-property rates, operating costs at 31% of the rent roll and a
 * platform fee at 8%. They existed because the real figures could not be
 * computed. They can now.
 *
 * COMMENTS ARE STRIPPED FIRST. Several of them describe exactly these
 * constants in order to record what was removed and why, and a guard that
 * fired on its own explanation would be rewritten around rather than obeyed.
 * ====================================================================== */
test("no screen derives money from an invented ratio", { skip }, () => {
  const raw = readFileSync(join(FE, "assets", "console.js"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")      /* block comments */
    .replace(/^\s*\/\/.*$/gm, " ");          /* line comments */

  const invented: Array<[RegExp, string]> = [
    [/\*\s*0?\.864/, "a flat 86.4% collection rate"],
    [/\*\s*0?\.031/, "arrears as 3.1% of the rent roll"],
    [/\[\s*\.94\s*,\s*\.88/, "a literal array of per-property collection rates"],
    [/rent\s*\*\s*0?\.31/, "operating costs as 31% of rent"],
    [/rent\s*\*\s*0?\.08/, "a platform fee as 8% of rent"],
  ];

  const found = invented.filter(([re]) => re.test(code)).map(([, what]) => what);
  assert.deepEqual(found, [],
    "these are made-up numbers presented as money:\n  " + found.join("\n  "));
});

/* The finance overview is the FINANCE role's landing screen, so what it shows
   has to be countable. */
test("the finance overview shows what is owed, not a guess", { skip }, async () => {
  const c = open(report());
  await c.settle();
  const html = (c.win["__S"] as Record<string, () => string>)["finance"]!();

  assert.match(html, /Rent roll/, "real, from the rollup of active leases");
  assert.match(html, /Outstanding/);
  assert.match(html, /Overdue/);
  assert.match(html, /KES 400K|KES 400,000/, "the real outstanding figure");
  assert.doesNotMatch(html, /86\.4%/);
  assert.doesNotMatch(html, /Net to owners/, "three fabrications subtracted from each other");
  assert.doesNotMatch(html, /Where the money goes/, "five fixed percentages");
  /* Three hard-coded markets on a finance screen is also the localisation
     mistake the platform was audited for. */
  assert.doesNotMatch(html, /M-Pesa · Bank/, "hard-coded markets");
});
