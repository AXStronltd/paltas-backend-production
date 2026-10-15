// Proves the TypeScript entitlement rules behave exactly like the hand-written browser file they replaced
// (kept unchanged in fixtures/entitlements.legacy.cjs). Thousands of random catalogues and organisations are run
// through both; every result, and every change the rules make to their input, must be identical.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { entitlements as ts } from "../dist/index.js";

const require = createRequire(import.meta.url);
const legacy: any = require("./fixtures/entitlements.legacy.cjs");
// the browser file the front end inlines (identical to its shared/entitlements.js), generated from the TypeScript source
const browserFile: any = require("../../browser/entitlements.js");

// small deterministic random generator, so a failure can be reproduced from its seed
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (a: number, b: number) => a + Math.floor(next() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const chance = (p: number) => next() < p;
  const subset = <T>(xs: readonly T[], p = 0.4): T[] => xs.filter(() => chance(p));
  return { int, pick, chance, subset };
}

const PRODUCTS = ["property", "developer", "agency", "hotel", "security"] as const;
const CCYS = ["KES", "USD", "UGX"] as const;
const date = (r: ReturnType<typeof rng>) =>
  `2026-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`;

function price(r: ReturnType<typeof rng>) {
  if (r.chance(0.25)) return null;
  if (r.chance(0.2)) return { byCcy: { [r.pick(CCYS)]: r.int(1, 9) * 1000 }, per: "month" };
  return {
    amount: r.chance(0.1) ? 0 : r.int(1, 90) * 1000,
    ccy: r.pick(CCYS),
    per: r.chance(0.5) ? "month" : undefined,
  };
}

function catalogue(r: ReturnType<typeof rng>) {
  const n = r.int(2, 8);
  const keys = Array.from({ length: n }, (_, i) => "m" + i);
  const modules = keys.map((key, i) => ({
    key,
    name: "Module " + i,
    products: r.subset(PRODUCTS, 0.5),
    dep: r.subset(keys.slice(0, i), 0.3),
    excludes: r.subset(keys, 0.1),
    scope: r.chance(0.3) ? "organisation" : r.chance(0.5) ? "product" : undefined,
    price: price(r),
    available: r.chance(0.85) ? undefined : false,
  }));
  const plans = Array.from({ length: r.int(1, 6) }, (_, i) => ({
    id: "P" + i,
    name: "Plan " + i,
    tier: r.pick(["Standard", "Pro", "Enterprise", null] as const),
    products: [r.pick(PRODUCTS)],
    modules: r.subset(keys, 0.5),
    buildingsIncluded: r.int(0, 5),
    base: price(r),
    extraBuilding: price(r),
    frequency: r.pick(["monthly", "quarterly", "weekly", undefined] as const),
    trialDays: r.chance(0.8) ? r.int(0, 100) : undefined,
    taxPct: r.chance(0.8) ? r.pick([0, 16, 120]) : null,
    taxNote: r.chance(0.5) ? "note" : undefined,
  }));
  return { modules, plans, keys };
}

function subscription(r: ReturnType<typeof rng>, cat: ReturnType<typeof catalogue>) {
  const pending = Array.from({ length: r.int(0, 3) }, () => {
    const t = r.pick(["plan", "cancelAddon", "cancel"] as const);
    return t === "plan"
      ? { type: t, plan: r.pick([...cat.plans.map((p) => p.id), "NOPE"]), effective: date(r) }
      : t === "cancelAddon"
        ? { type: t, key: r.pick(cat.keys), effective: date(r) }
        : { type: t, effective: date(r) };
  });
  return {
    plan: r.pick([...cat.plans.map((p) => p.id), "CORE", "MISSING"]),
    status: r.pick(["trial", "active", "suspended", "expired"] as const),
    trialEnds: r.chance(0.6) ? date(r) : null,
    anchor: r.chance(0.6) ? date(r) : null,
    addons: r.chance(0.9) ? r.subset(cat.keys, 0.3) : undefined,
    disabled: r.chance(0.8) ? r.subset(cat.keys, 0.15) : undefined,
    pending: r.chance(0.8) ? pending : undefined,
    buildings: r.chance(0.8) ? { extra: r.int(0, 3), override: r.chance(0.2) ? r.int(0, 4) : null } : undefined,
    terms: r.chance(0.5) ? { discountPct: r.pick([0, 10, 25]), note: "" } : undefined,
    usage: r.chance(0.7) ? { buildings: r.int(0, 8) } : undefined,
  };
}

function organisation(r: ReturnType<typeof rng>, cat: ReturnType<typeof catalogue>) {
  const type = r.pick([...PRODUCTS, "agents"] as const);
  const subs: Record<string, unknown> = {};
  for (const p of r.subset(PRODUCTS, 0.3)) if (p !== type) subs[p] = subscription(r, cat);
  return {
    id: "O1",
    name: "Org",
    type,
    currency: r.pick(CCYS),
    demo: r.chance(0.2),
    ent: subscription(r, cat),
    subs: r.chance(0.8) ? subs : undefined,
  };
}

const clone = <T>(x: T): T => structuredClone(x);

/** Added after the browser file was replaced (the platform trial policy); everything else must match exactly. */
const ADDED = ["DEFAULT_TRIAL_POLICY", "trialState"];
const sameNames = (impl: object) => expect(Object.keys(impl).sort()).toEqual([...Object.keys(legacy), ...ADDED].sort());

let candidate: typeof legacy = ts;

/** Run fn on separate copies of the input with each implementation; results and input changes must match. */
function same<T>(input: T, call: (impl: typeof legacy, input: T) => unknown) {
  const a = clone(input);
  const b = clone(input);
  const outLegacy = call(legacy, a);
  const outTs = call(candidate, b);
  expect(JSON.parse(JSON.stringify(outTs ?? null))).toStrictEqual(JSON.parse(JSON.stringify(outLegacy ?? null)));
  expect(b).toStrictEqual(a);
}

describe("entitlement rules: TypeScript = the earlier browser implementation", () => {
  it("exports the same names (plus the trial policy additions)", () => {
    sameNames(ts);
  });

  it("date helpers agree", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const d = `20${r.int(24, 30)}-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 31)).padStart(2, "0")}`;
      const n = r.int(-40, 40);
      expect(ts.addDays(d, n)).toBe(legacy.addDays(d, n));
      expect(ts.addMonths(d, n)).toBe(legacy.addMonths(d, n));
    }
  });

  it.each([
    ["the TypeScript source", ts, 3000],
    ["the generated browser file (browser/entitlements.js)", browserFile, 1000],
  ])(
    "every rule agrees: %s",
    (_label, impl, seeds) => {
      candidate = impl;
      sameNames(impl);
      for (let seed = 1; seed <= seeds; seed++) {
        const r = rng(seed);
        const cat = catalogue(r);
        const org = organisation(r, cat);
        const today = date(r);
        const c = { modules: cat.modules, plans: cat.plans };
        try {
          for (const product of [undefined, ...PRODUCTS]) {
            same({ c, org }, (impl, x) => impl.viewOf(x.c, x.org, product, today));
            same({ c, org }, (impl, x) => {
              const v = impl.viewOf(x.c, x.org, product, today);
              return (
                v && [impl.resolve(x.c, v, today), impl.charges(x.c, v, today), impl.charges(x.c, v, today, "USD")]
              );
            });
            same({ c, org }, (impl, x) => {
              const v = impl.viewOf(x.c, x.org, product, today);
              return v && [...cat.keys, "unknown"].map((k) => impl.canBuy(x.c, v, k, today));
            });
            same({ c, org }, (impl, x) => {
              const v = impl.viewOf(x.c, x.org, product, today);
              return v && [...cat.plans.map((p) => p.id), "unknown"].map((p) => impl.canChangePlan(x.c, v, p, today));
            });
          }
          same({ c, org }, (impl, x) => [impl.productsOf(x.org), impl.subOf(x.org, "developer"), impl.subOf(x.org)]);
          same({ c, org }, (impl, x) => impl.nextBilling(x.org, today));
          same({ c, org }, (impl, x) => impl.resolve(x.c, x.org, today));
          same(c, (impl, x) => x.plans.map((p) => impl.validatePlan(x, p)));
          same(c, (impl, x) => x.modules.map((m) => impl.validateModule(x, m.key, m)));
          same(c, (impl, x) => x.modules.map((m) => [impl.priceIn(m.price, "KES"), impl.priceIn(m.price, undefined)]));
        } catch (e) {
          throw new Error(`Mismatch for seed ${seed}: ${(e as Error).message}`, { cause: e });
        }
      }
    },
    300_000,
  ); // thousands of cases: allow time when every suite runs in parallel

  it("constants agree", () => {
    for (const k of ["ESSENTIALS", "FLOOR", "TIER_RANK", "PRODUCT_NAME", "v"] as const) {
      expect((ts as Record<string, unknown>)[k]).toStrictEqual(legacy[k]);
    }
  });
});
