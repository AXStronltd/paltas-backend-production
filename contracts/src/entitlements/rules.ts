/*
 * PALTAS entitlement rules — ONE implementation for the server and the browser.
 *
 * The server imports this module directly. The browser gets `shared/entitlements.js`, which is GENERATED from this
 * file by `npm run browser:build` (never edit the generated file). `npm run browser:check` fails if it is out of date.
 *
 * Pure functions: no storage, no clock, no network. They answer "what is this organisation entitled to, and what
 * would a change cost"; nothing here charges money.
 *
 * Inputs: cat = catalogue {modules, plans}; org = organisation record (first product in `ent`, further products in
 * `subs[product]`); today = "YYYY-MM-DD". viewOf(cat, org, product, today) gives the record for one product, which the
 * other functions work on. Subscribing to one product never activates another. A module's `scope` decides whether a
 * plan or add-on covers one product ("product", default) or the whole organisation ("organisation" — never charged twice).
 *
 * Behaviour is kept identical to the earlier hand-written browser file (proved by contracts/test/entitlements.parity.test.ts),
 * including that resolve() fills in missing defaults (addons, disabled, buildings) on the subscription it is given.
 */
import type {
  BuyCheck,
  Catalogue,
  CatalogueModule,
  Charges,
  ChargeLine,
  Entitlement,
  ModuleState,
  OrgRecord,
  OrgType,
  OrgView,
  Plan,
  PlanChangeCheck,
  Price,
  PriceIn,
  Subscription,
  Tier,
  TrialPolicy,
  TrialState,
} from "./types.js";

/** Version of the rules API (the browser has always exposed `v: 1`). */
export const v = 1;

/** Always available, never sold, never switched off. */
export const ESSENTIALS: readonly (readonly [string, string])[] = [
  ["auth", "Sign-in and identity"],
  ["access", "Roles and access control"],
  ["isolation", "Organisation isolation"],
  ["sec", "Security settings"],
  ["audit", "Audit trail"],
];

/** What keeps working without any optional module, so a plan never breaks a dependent workflow. */
export const FLOOR: Record<string, string[]> = {
  property: [
    "Properties, units and tenants",
    "Leases",
    "Invoices and payment status",
    "Tenant identity and contact details",
    "Maintenance requests",
  ],
  developer: ["Projects and units", "Buyers and reservations", "Sales and payment-plan status", "Documents"],
  agency: ["Listings", "Contacts and enquiries"],
  hotel: ["Rooms and reservations"],
  security: ["Sites, guards and incidents"],
};

export const TIER_RANK: Record<Tier, number> = { Standard: 1, Pro: 2, Enterprise: 3 };

/**
 * The first version of the ONE platform trial policy, identical for every product. The server keeps the live policy
 * in its database (seeded with these values, changed only by a Super Admin); pages connected to the API show the
 * server's numbers, and these are what the browser shows before then.
 */
export const DEFAULT_TRIAL_POLICY: TrialPolicy = {
  trialDays: 30,
  graceDays: 7,
  reminderDays: [7, 3, 1],
  verifyWithinDays: 7,
  verifyLinkHours: 48,
  repeatWindowDays: 365,
  repeatMatch: ["email", "phone", "company"],
  secondProduct: "own_trial",
  atExpiry: "read_only",
  keepRecords: true,
  exportAllowed: true,
};

export const PRODUCT_NAME: Record<string, string> = {
  property: "Property Management",
  agents: "Agent & Host",
  agency: "Agent & Host",
  developer: "Real Estate Development",
  hotel: "Hotel",
  security: "Security Services",
};

/**
 * Module names in words, for messages when a catalogue row is missing (people never read internal keys). The
 * catalogue's own name wins whenever the row exists.
 */
export const MODULE_NAME: Record<string, string> = {
  crm: "Advanced CRM and Marketing",
  maint: "Maintenance",
  finance: "Finance and Accounting",
  payments: "Payments and Banking",
  procurement: "Supplier and Procurement Management",
  intelligence: "Advanced Reports and Intelligence",
  docs: "Document Intelligence",
  automation: "Workflow Automation",
};

/** Any organisation shape resolve() accepts: a stored record or a per-product view. */
type ResolvableOrg = (OrgRecord | OrgView) & { shared?: Record<string, string>; products?: string[] };

const rank = (tier: Tier | null | undefined): number => (tier ? TIER_RANK[tier] || 0 : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Same day next month(s), clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  const day = t.getUTCDate();
  t.setUTCDate(1);
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

const dayNumber = (d: string): number => Math.round(new Date(d + "T00:00:00Z").getTime() / 86_400_000);

/**
 * Where a subscription stands in its trial today: in the trial, in its grace days (still working), or expired
 * (read-only, records kept). Null when it is not a trial (never was, or paid since). The same answer as resolve():
 * a trial is usable through trialEnds + graceDays.
 */
export function trialState(sub: Subscription | null | undefined, today: string): TrialState | null {
  if (!sub || !sub.trialEnds || !(sub.status === "trial" || (sub.status === "expired" && !sub.anchor))) return null;
  const grace = sub.graceDays || 0;
  const graceEnds = addDays(sub.trialEnds, grace);
  const phase = sub.status === "expired" || graceEnds < today ? "expired" : sub.trialEnds < today ? "grace" : "trial";
  return {
    phase,
    trialEnds: sub.trialEnds,
    graceEnds,
    daysLeft: Math.max(0, dayNumber(sub.trialEnds) - dayNumber(today)),
    graceDaysLeft: phase === "expired" ? 0 : phase === "grace" ? dayNumber(graceEnds) - dayNumber(today) : grace,
  };
}

export function productOf(org: { type?: OrgType } | null | undefined): string {
  const t = org && org.type;
  return t === "agents" ? "agency" : t || "property";
}

function planById(cat: Catalogue, id: string): Plan | null {
  return cat.plans.find((p) => p.id === id) ?? null;
}
function moduleByKey(cat: Catalogue, key: string): CatalogueModule | null {
  return cat.modules.find((m) => m.key === key) ?? null;
}
export const moduleName = (cat: Catalogue, key: string): string =>
  (moduleByKey(cat, key) || { name: MODULE_NAME[key] || "This module" }).name;

function corePlan(org: { type?: OrgType }): Plan {
  return {
    id: "CORE",
    name: "Core product — no plan assigned yet",
    tier: null,
    products: [productOf(org)],
    modules: [],
    buildingsIncluded: 1,
    extraBuilding: null,
    base: null,
    frequency: "monthly",
    trialDays: DEFAULT_TRIAL_POLICY.trialDays,
    taxPct: 0,
    taxNote: "Set when PALTAS assigns a plan",
    capacity: { sites: null, units: null },
  };
}

/** A price applies only in its own currency (or a currency PALTAS has set for it); nothing is converted or invented. */
export function priceIn(price: Price | null | undefined, ccy?: string | null): PriceIn | null {
  if (!price) return null;
  if (ccy && price.byCcy && price.byCcy[ccy] != null) {
    return { amount: +price.byCcy[ccy], ccy, per: price.per || "month" };
  }
  if (price.amount == null) return null;
  if (!ccy || price.ccy === ccy) return { amount: +price.amount, ccy: price.ccy as string, per: price.per || "month" };
  return null;
}

/** Pending changes (cancellation, downgrade) take effect on their date; before it the current entitlement stands. */
function effectivePlanId(org: { ent: Subscription }, today: string): string {
  const e = org.ent;
  let id = e.plan;
  (e.pending || []).forEach((p) => {
    if (p.type === "plan" && p.effective <= today) id = p.plan;
  });
  return id;
}

function cancelledAddons(org: { ent: Subscription }, today: string): string[] {
  return (org.ent.pending || [])
    .filter((p) => p.type === "cancelAddon" && p.effective <= today)
    .map((p) => p.key as string);
}

export function nextBilling(org: { ent: Subscription }, today: string): string | null {
  const e = org.ent;
  if (e.status === "trial" && e.trialEnds) return e.trialEnds;
  const a = e.anchor;
  if (!a) return null;
  let n = a;
  let guard = 0;
  while (n <= today && guard++ < 600) n = addMonths(a, guard);
  return n;
}

export function productsOf(org: Pick<OrgRecord, "type" | "subs"> | null | undefined): string[] {
  const a: string[] = org && org.type ? [org.type] : [];
  const subs = (org && org.subs) || {};
  Object.keys(subs).forEach((k) => {
    if (subs[k] && a.indexOf(k) < 0) a.push(k);
  });
  return a;
}

export function subOf(org: OrgRecord | null | undefined, product?: string | null): Subscription | null {
  if (!org) return null;
  if (!product || product === org.type) return org.ent || null;
  return (org.subs || {})[product] || null;
}

/** The record for one product subscription; organisation-wide modules held through another product go in `shared`. */
export function viewOf(
  cat: Catalogue,
  org: OrgRecord,
  product: string | null | undefined,
  today: string,
): OrgView | null {
  const p = product || org.type;
  const s = subOf(org, p);
  if (!s) return null;
  const all = productsOf(org);
  const me = all.indexOf(p);
  const shared: Record<string, string> = {};
  all.forEach((q, qi) => {
    if (q === p) return;
    const other: OrgView = {
      id: org.id,
      name: org.name,
      type: q as OrgType,
      currency: org.currency,
      demo: !!org.demo,
      ent: subOf(org, q) as Subscription,
    };
    const r = resolve(cat, other, today);
    if (!r || !r.usable) return;
    cat.modules.forEach((m) => {
      const st = r.moduleState[m.key];
      if (m.scope !== "organisation" || !st || !st.on || shared[m.key]) return;
      // a plan module is shared both ways; an add-on bought for an earlier product is paid there and shared to later ones
      if (st.source === "plan" || (st.source === "addon" && qi < me)) shared[m.key] = PRODUCT_NAME[q] || q;
    });
  });
  return {
    id: org.id,
    name: org.name,
    type: p as OrgType,
    currency: org.currency,
    demo: !!org.demo,
    ent: s,
    shared,
    products: all,
  };
}

/** What one product subscription is entitled to today. */
export function resolve(cat: Catalogue, org: ResolvableOrg | null | undefined, today: string): Entitlement | null {
  if (!org) return null;
  const e: Subscription = org.ent || ({} as Subscription);
  // defaults are filled in on the stored subscription itself (the browser has always relied on this)
  e.addons = e.addons || [];
  e.disabled = e.disabled || [];
  e.buildings = e.buildings || { extra: 0, override: null };
  const addons = e.addons;
  const disabled = e.disabled;
  const buildings = e.buildings;

  const pl = planById(cat, effectivePlanId(org, today)) || corePlan(org);
  const prod = productOf(org);
  const trialOver = e.status === "trial" && !!e.trialEnds && addDays(e.trialEnds, e.graceDays || 0) < today;
  const ended = (e.pending || []).some((p) => p.type === "cancel" && p.effective <= today);
  const status = ended ? "cancelled" : trialOver ? "expired" : e.status || "trial";
  const gone = cancelledAddons(org, today);
  const pend = e.pending || [];
  const shared = org.shared || {};

  const on: Record<string, boolean> = {};
  const state: Record<string, ModuleState> = {};
  cat.modules.forEach((m) => {
    const products = m.products || [];
    const inPlan = pl.modules.indexOf(m.key) >= 0;
    const addon = addons.indexOf(m.key) >= 0 && gone.indexOf(m.key) < 0;
    const offered = products.indexOf(prod) >= 0 || (pl.products || []).some((p) => products.indexOf(p) >= 0);
    const viaOrg = !inPlan && m.scope === "organisation" && !!shared[m.key] && offered;
    const isOn = (inPlan || addon || viaOrg) && disabled.indexOf(m.key) < 0 && m.available !== false;
    const cancelsOn =
      pend.filter((p) => p.type === "cancelAddon" && p.key === m.key && p.effective > today)[0]?.effective || null;
    on[m.key] = isOn;
    state[m.key] = {
      on: isOn,
      source: inPlan ? "plan" : viaOrg ? "organisation" : addon ? "addon" : null,
      sharedFrom: viaOrg ? (shared[m.key] ?? null) : null,
      scope: m.scope || "product",
      offered,
      available: m.available !== false,
      cancelsOn,
      why: "",
    };
  });
  // a module without its dependency is unavailable (its records are kept)
  cat.modules.forEach((m) => {
    const st = state[m.key] as ModuleState;
    if (on[m.key] && (m.dep || []).some((d) => !on[d])) {
      on[m.key] = false;
      st.on = false;
      st.why = "Needs " + (m.dep || []).map((d) => moduleName(cat, d)).join(", ");
    }
  });
  cat.modules.forEach((m) => {
    const s = state[m.key] as ModuleState;
    if (s.on || s.why) return;
    s.why = !s.offered
      ? "Not offered for this product"
      : !s.available
        ? "Not available yet"
        : disabled.indexOf(m.key) >= 0
          ? "Switched off by PALTAS"
          : "Not in your plan";
  });

  const included = buildings.override != null ? buildings.override : pl.buildingsIncluded;
  const allowed = included + (buildings.extra || 0);
  const used = (e.usage || { buildings: 0 }).buildings || 0;
  const family = cat.plans
    .filter((x) => (x.products || [])[0] === (pl.products || [])[0] && x.tier)
    .sort((a, b) => rank(a.tier) - rank(b.tier));
  const myRank = rank(pl.tier);

  return {
    org: org.id,
    name: org.name,
    demo: !!org.demo,
    product: prod,
    productKey: org.type,
    productName: PRODUCT_NAME[org.type] || org.type,
    orgProducts: org.products || [org.type],
    status,
    usable: status === "active" || status === "trial",
    readOnly: !(status === "active" || status === "trial"),
    plan: pl,
    planId: pl.id,
    tier: pl.tier || null,
    trialEnds: e.trialEnds || null,
    products: pl.products,
    modules: on,
    moduleState: state,
    essentials: ESSENTIALS.map((x) => x[1]),
    floor: FLOOR[prod] || [],
    buildings: {
      included,
      extra: buildings.extra || 0,
      allowed,
      used,
      left: Math.max(0, allowed - used),
      over: used > allowed,
    },
    extraBuilding: pl.extraBuilding,
    frequency: pl.frequency,
    taxPct: pl.taxPct,
    taxNote: pl.taxNote,
    terms: e.terms || { discountPct: 0, note: "" },
    billing: e.billing || { status: "" },
    nextBilling: nextBilling(org, today),
    pending: pend.filter((p) => p.effective > today),
    upgrades: family
      .filter((x) => rank(x.tier) > myRank)
      .map((x) => ({ id: x.id, tier: x.tier, name: x.name, contactSales: x.tier === "Enterprise" || !x.base })),
    downgrades: family
      .filter((x) => rank(x.tier) < myRank && myRank < 3)
      .map((x) => ({ id: x.id, tier: x.tier, name: x.name })),
  };
}

/** The monthly charge: plan base + paid add-ons (never a module already in the plan) + extra buildings. */
export function charges(cat: Catalogue, org: ResolvableOrg, today: string, ccy?: string): Charges {
  const en = resolve(cat, org, today) as Entitlement;
  const pl = en.plan;
  const c = ccy || org.currency;
  const lines: ChargeLine[] = [];
  const missing: string[] = [];
  const base = priceIn(pl.base, c);
  if (pl.base && pl.base.amount != null && !base) missing.push(pl.name);
  if (base) lines.push({ kind: "plan", what: pl.name, amount: base.amount });
  (org.ent.addons || []).forEach((k) => {
    const s = en.moduleState[k];
    if (!s || s.source !== "addon" || !s.on) return;
    const m = moduleByKey(cat, k);
    const p = priceIn(m && m.price, c);
    if (!p || !m) {
      missing.push(m ? m.name : k);
      return;
    }
    lines.push({ kind: "addon", key: k, what: m.name, amount: p.amount });
  });
  const xb = priceIn(pl.extraBuilding, c);
  if (en.buildings.extra > 0) {
    if (xb)
      lines.push({
        kind: "buildings",
        what: "Additional buildings × " + en.buildings.extra,
        amount: xb.amount * en.buildings.extra,
      });
    else missing.push("Additional buildings");
  }
  const gross = lines.reduce((a, l) => a + l.amount, 0);
  const disc = r2(gross * ((en.terms.discountPct || 0) / 100));
  const net = r2(gross - disc);
  const tax = r2(net * ((pl.taxPct || 0) / 100));
  return {
    ccy: c,
    lines,
    gross: r2(gross),
    discount: disc,
    net,
    taxPct: pl.taxPct || 0,
    taxNote: pl.taxNote || "",
    tax,
    total: r2(net + tax),
    missing,
    priced: !missing.length && lines.length > 0,
  };
}

/** Can this organisation buy this module? Never twice, never one its product cannot use, never without its dependency. */
export function canBuy(cat: Catalogue, org: ResolvableOrg, key: string, today: string): BuyCheck {
  const en = resolve(cat, org, today) as Entitlement;
  const m = moduleByKey(cat, key);
  if (!m) return { ok: false, why: "Unknown module" };
  const s = en.moduleState[key] as ModuleState;
  if (!en.usable) return { ok: false, why: "Your subscription is " + en.status + " — renew or choose a plan first" };
  if (s.source === "plan")
    return { ok: false, included: true, why: m.name + " is already included in your plan — there is nothing to buy" };
  if (s.source === "organisation")
    return {
      ok: false,
      included: true,
      why:
        m.name +
        " already covers your whole organisation through your " +
        s.sharedFrom +
        " subscription — there is nothing to buy",
    };
  if (s.source === "addon" && !s.cancelsOn)
    return { ok: false, owned: true, why: m.name + " is already active on your subscription" };
  if (!s.offered)
    return {
      ok: false,
      why: m.name + " is not offered for " + (PRODUCT_NAME[en.product] || en.product) + " workspaces",
    };
  if (m.available === false) return { ok: false, why: m.name + " is not available yet" };
  const clash = (m.excludes || []).filter((x) => en.modules[x]);
  if (clash.length)
    return { ok: false, why: m.name + " cannot be combined with " + clash.map((x) => moduleName(cat, x)).join(", ") };
  const need = (m.dep || []).filter((d) => !en.modules[d]);
  if (need.length)
    return {
      ok: false,
      needs: need,
      why: m.name + " needs " + need.map((d) => moduleName(cat, d)).join(", ") + " first",
    };
  if (en.tier === "Enterprise")
    return {
      ok: false,
      contactSales: true,
      why: "Enterprise packages are agreed with PALTAS — ask your account manager",
    };
  const p = priceIn(m.price, org.currency);
  if (!p)
    return {
      ok: false,
      contactSales: true,
      why: "PALTAS has not set a price for " + m.name + " in " + org.currency + " yet — ask PALTAS for a quote",
    };
  const disc = r2(p.amount * ((en.terms.discountPct || 0) / 100));
  const net = r2(p.amount - disc);
  const tax = r2(net * ((en.plan.taxPct || 0) / 100));
  return {
    ok: true,
    module: m,
    price: p,
    discount: disc,
    net,
    tax,
    total: r2(net + tax),
    taxNote: en.plan.taxNote,
    from: today,
    nextBilling: en.nextBilling,
  };
}

/** Plan change: upgrades now, downgrades at the next billing date, never below the buildings in use, Enterprise via PALTAS. */
export function canChangePlan(cat: Catalogue, org: ResolvableOrg, planId: string, today: string): PlanChangeCheck {
  const en = resolve(cat, org, today) as Entitlement;
  const to = planById(cat, planId);
  if (!to) return { ok: false, why: "Unknown plan" };
  const renew = to.id === en.planId && (en.status === "expired" || en.status === "cancelled");
  if (to.id === en.planId && !renew) return { ok: false, why: "You are already on " + to.name };
  if ((to.products || [])[0] !== (en.plan.products || [])[0] && en.planId !== "CORE")
    return { ok: false, why: to.name + " is for a different product" };
  if (to.tier === "Enterprise" || !to.base)
    return {
      ok: false,
      contactSales: true,
      why: "Enterprise is agreed with PALTAS — send a request and an account manager will contact you",
    };
  const up = renew || rank(to.tier) > rank(en.tier) || en.planId === "CORE" || !en.usable;
  const allow = (to.buildingsIncluded || 0) + (en.buildings.extra || 0);
  if (!up && en.buildings.used > allow)
    return {
      ok: false,
      why:
        "You use " +
        en.buildings.used +
        " buildings; " +
        to.name +
        " allows " +
        allow +
        ". Keep your extra buildings or stay on your plan.",
    };
  const addons = org.ent.addons || [];
  const lost = en.plan.modules
    .filter((k) => to.modules.indexOf(k) < 0 && addons.indexOf(k) < 0)
    .map((k) => moduleName(cat, k));
  const p = priceIn(to.base, org.currency);
  if (!p)
    return {
      ok: false,
      contactSales: true,
      why: "PALTAS has not set a price for " + to.name + " in " + org.currency + " yet",
    };
  const effective = up ? today : en.nextBilling || today;
  const dup = addons.filter((k) => to.modules.indexOf(k) >= 0).map((k) => moduleName(cat, k));
  return {
    ok: true,
    upgrade: up,
    renew,
    plan: to,
    price: p,
    effective,
    readOnlyAfter: lost,
    addonsBecomeIncluded: dup,
  };
}

/** Catalogue validation used by Super Admin before a plan is saved. Returns the problems found (empty = valid). */
export function validatePlan(cat: Catalogue, pl: Partial<Plan>): string[] {
  const errs: string[] = [];
  if (!pl || String(pl.name || "").trim().length < 3) errs.push("Name the plan");
  const prods = pl.products || [];
  if (!prods.length) errs.push("Pick the product this plan is for");
  const mods = pl.modules || [];
  mods.forEach((k) => {
    const m = moduleByKey(cat, k);
    if (!m) {
      errs.push("Unknown module " + k);
      return;
    }
    if (!prods.some((p) => (m.products || []).indexOf(p) >= 0))
      errs.push(m.name + " is not offered for " + prods.join(", "));
    (m.dep || []).forEach((d) => {
      if (mods.indexOf(d) < 0) errs.push(m.name + " needs " + moduleName(cat, d) + " in the same plan");
    });
    (m.excludes || []).forEach((x) => {
      if (mods.indexOf(x) >= 0) errs.push(m.name + " cannot be sold with " + moduleName(cat, x));
    });
  });
  if (!((pl.buildingsIncluded as number) >= 0)) errs.push("Included buildings must be 0 or more");
  if (pl.base && pl.base.amount != null && !(+pl.base.amount > 0))
    errs.push("Base price must be above zero, or leave it for PALTAS to agree (Enterprise)");
  if (pl.taxPct != null && !(pl.taxPct >= 0 && pl.taxPct <= 100)) errs.push("Tax 0–100%");
  if (["monthly", "quarterly", "yearly"].indexOf(pl.frequency || "monthly") < 0)
    errs.push("Billing period must be monthly, quarterly or yearly");
  if (pl.trialDays != null && !(pl.trialDays >= 0 && pl.trialDays <= 90)) errs.push("Trial 0–90 days");
  return errs;
}

/** Catalogue validation used by Super Admin before a module is saved. */
export function validateModule(
  _cat: Catalogue,
  key: string,
  m: { dep?: string[]; excludes?: string[]; price?: Price | null; scope?: string | null },
): string[] {
  const errs: string[] = [];
  if ((m.dep || []).indexOf(key) >= 0) errs.push("A module cannot depend on itself");
  if ((m.excludes || []).indexOf(key) >= 0) errs.push("A module cannot exclude itself");
  (m.dep || []).forEach((d) => {
    if ((m.excludes || []).indexOf(d) >= 0) errs.push("A module cannot both need and exclude " + d);
  });
  if (m.price && m.price.amount != null && !(+m.price.amount > 0)) errs.push("Price must be above zero, or unset");
  if (m.scope != null && ["product", "organisation"].indexOf(m.scope) < 0)
    errs.push("Scope must be per product or organisation-wide");
  // a module already sold inside a plan can still be bought separately only by organisations whose plan lacks it
  // (checked at purchase)
  return errs;
}
