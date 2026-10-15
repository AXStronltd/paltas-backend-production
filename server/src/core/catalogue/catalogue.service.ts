/*
 * The catalogue: modules and plans with their prices, as PALTAS configures them (Super Admin). Prices live in the
 * database, never in code. This module reads the catalogue in the shape the entitlement rules expect, and saves
 * Super Admin changes after the rules' own validation.
 */
import { entitlements, type Catalogue, type CatalogueModule, type Plan, type Tier } from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { toMajor } from "../../lib/money.js";

interface ModuleRow {
  key: string;
  name: string;
  products: string[];
  deps: string[];
  excludes: string[];
  price_minor: number | null;
  price_ccy: string | null;
  per: string;
  scope: "product" | "organisation";
  available: boolean;
}

export interface PlanRow {
  id: string;
  name: string;
  tier: Tier | null;
  product: string;
  modules: string[];
  buildings_included: number;
  base_minor: number | null;
  extra_building_minor: number | null;
  currency: string | null;
  frequency: "monthly" | "quarterly" | "yearly";
  trial_days: number;
  tax_pct: number | null;
  tax_note: string;
  cap_sites: number | null;
  cap_units: number | null;
}

const majorPrice = (minor: number | null, ccy: string | null, per = "month") =>
  minor == null || !ccy ? null : { amount: toMajor(minor, ccy), ccy, per };

export function planFromRow(p: PlanRow): Plan & {
  base: ReturnType<typeof majorPrice>;
  extraBuilding: ReturnType<typeof majorPrice>;
  frequency: PlanRow["frequency"];
  trialDays: number;
  taxPct: number | null;
  taxNote: string;
  capacity: { sites: number | null; units: number | null };
} {
  return {
    id: p.id,
    name: p.name,
    tier: p.tier,
    products: [p.product],
    modules: p.modules,
    buildingsIncluded: p.buildings_included,
    base: majorPrice(p.base_minor, p.currency),
    extraBuilding: majorPrice(p.extra_building_minor, p.currency),
    frequency: p.frequency,
    trialDays: p.trial_days,
    taxPct: p.tax_pct,
    taxNote: p.tax_note,
    capacity: { sites: p.cap_sites, units: p.cap_units },
  };
}

function moduleFromRow(m: ModuleRow): CatalogueModule & {
  products: string[];
  dep: string[];
  excludes: string[];
  scope: "product" | "organisation";
  price: ReturnType<typeof majorPrice>;
  available: boolean;
} {
  return {
    key: m.key,
    name: m.name,
    products: m.products,
    dep: m.deps,
    excludes: m.excludes,
    scope: m.scope,
    price: majorPrice(m.price_minor, m.price_ccy, m.per),
    available: m.available,
  };
}

/**
 * Active plans and all modules, in the shape the entitlement rules and the API use. Every plan shows the trial
 * length of the ONE platform trial policy (migration 0013): per-plan trial days are not used.
 */
export async function loadCatalogue(db: Db) {
  const modules = (await db.rows<ModuleRow>("SELECT * FROM catalogue_modules ORDER BY key")).map(moduleFromRow);
  const policy = await db.row<{ trial_days: number }>("SELECT trial_days FROM trial_policy WHERE id = 1");
  const plans = (await db.rows<PlanRow>("SELECT * FROM catalogue_plans WHERE active ORDER BY id")).map((p) =>
    planFromRow({ ...p, trial_days: policy?.trial_days ?? p.trial_days }),
  );
  return { modules, plans } satisfies Catalogue;
}

export async function findPlan(db: Db, id: string): Promise<PlanRow | null> {
  return db.row<PlanRow>("SELECT * FROM catalogue_plans WHERE id = $1 AND active", [id]);
}

export interface PlanInput {
  name: string;
  tier: Tier | null;
  product: string;
  modules: string[];
  buildingsIncluded: number;
  baseMinor: number | null;
  extraBuildingMinor: number | null;
  currency?: string | undefined;
  frequency: "monthly" | "quarterly" | "yearly";
  trialDays: number;
  taxPct: number | null;
  taxNote: string;
  capSites: number | null;
  capUnits: number | null;
}

/** Create or change a plan after the shared rules have validated it. Returns the row before the change (null = new). */
export async function savePlan(db: Db, id: string, b: PlanInput): Promise<{ before: PlanRow | null; after: PlanRow }> {
  if ((b.baseMinor != null || b.extraBuildingMinor != null) && !b.currency)
    throw fail.invalid("Give the currency of the prices");
  const cat = await loadCatalogue(db);
  const errs = entitlements.validatePlan(cat, {
    name: b.name,
    tier: b.tier,
    products: [b.product],
    modules: b.modules,
    buildingsIncluded: b.buildingsIncluded,
    base: b.baseMinor == null ? null : { amount: b.baseMinor, ccy: b.currency },
    frequency: b.frequency,
    trialDays: b.trialDays,
    taxPct: b.taxPct,
  });
  if (errs.length) throw fail.invalid(errs.join(" · "), { errors: errs });
  const before = await db.row<PlanRow>("SELECT * FROM catalogue_plans WHERE id = $1", [id]);
  const after = await db.row<PlanRow>(
    `INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
       currency, frequency, trial_days, tax_pct, tax_note, cap_sites, cap_units, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, product = EXCLUDED.product,
       modules = EXCLUDED.modules, buildings_included = EXCLUDED.buildings_included, base_minor = EXCLUDED.base_minor,
       extra_building_minor = EXCLUDED.extra_building_minor, currency = EXCLUDED.currency, frequency = EXCLUDED.frequency,
       trial_days = EXCLUDED.trial_days, tax_pct = EXCLUDED.tax_pct, tax_note = EXCLUDED.tax_note,
       cap_sites = EXCLUDED.cap_sites, cap_units = EXCLUDED.cap_units, updated_at = now()
     RETURNING *`,
    [
      id,
      b.name,
      b.tier,
      b.product,
      b.modules,
      b.buildingsIncluded,
      b.baseMinor,
      b.extraBuildingMinor,
      b.currency ?? null,
      b.frequency,
      b.trialDays,
      b.taxPct,
      b.taxNote,
      b.capSites,
      b.capUnits,
    ],
  );
  return { before, after: after as PlanRow };
}

export interface ModuleInput {
  deps?: string[] | undefined;
  excludes?: string[] | undefined;
  priceMinor?: number | null | undefined;
  currency?: string | undefined;
  available?: boolean | undefined;
  products?: string[] | undefined;
  scope?: "product" | "organisation" | undefined;
}

export async function saveModule(
  db: Db,
  key: string,
  b: ModuleInput,
): Promise<{ before: ModuleRow; after: ModuleRow }> {
  const before = await db.row<ModuleRow>("SELECT * FROM catalogue_modules WHERE key = $1", [key]);
  if (!before) throw fail.notFound("Unknown module");
  const next = {
    deps: b.deps ?? before.deps,
    excludes: b.excludes ?? before.excludes,
    priceMinor: b.priceMinor === undefined ? before.price_minor : b.priceMinor,
    currency: b.currency ?? before.price_ccy,
    available: b.available ?? before.available,
    products: b.products ?? before.products,
    scope: b.scope ?? before.scope,
  };
  if (next.priceMinor != null && !next.currency) throw fail.invalid("Give the currency of the price");
  const cat = await loadCatalogue(db);
  const errs = entitlements.validateModule(cat, key, {
    dep: next.deps,
    excludes: next.excludes,
    price: next.priceMinor == null ? null : { amount: next.priceMinor },
    scope: next.scope,
  });
  const unknown = [...next.deps, ...next.excludes].filter((k) => !cat.modules.some((m) => m.key === k));
  if (unknown.length) errs.push("Unknown module(s): " + unknown.join(", "));
  const clash = cat.plans
    .filter((pl) => pl.modules.includes(key) && next.excludes.some((x) => pl.modules.includes(x)))
    .map((pl) => pl.name);
  if (clash.length) errs.push("Plans already sell it with an excluded module: " + clash.join(", "));
  if (errs.length) throw fail.invalid(errs.join(" · "), { errors: errs });
  const after = await db.row<ModuleRow>(
    `UPDATE catalogue_modules SET deps = $2, excludes = $3, price_minor = $4, price_ccy = $5, available = $6,
       products = $7, scope = $8, updated_at = now() WHERE key = $1 RETURNING *`,
    [
      key,
      next.deps,
      next.excludes,
      next.priceMinor,
      next.priceMinor == null ? null : next.currency,
      next.available,
      next.products,
      next.scope,
    ],
  );
  return { before, after: after as ModuleRow };
}
