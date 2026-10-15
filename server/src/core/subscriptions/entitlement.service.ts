/*
 * Builds an organisation's subscriptions from the database in the shape the shared entitlement rules expect, and
 * resolves what one product subscription is entitled to today. This is the only place that reads subscription
 * tables for entitlement decisions.
 */
import {
  entitlements,
  type Entitlement,
  type OrgRecord,
  type OrgView,
  type PendingChange,
  type Product,
  type Subscription,
} from "@paltas/contracts";
import type { Db } from "../../db/database.js";
import type { ProductRegistry } from "../../products/registry.js";
import { loadCatalogue } from "../catalogue/catalogue.service.js";

interface OrgRow {
  id: string;
  name: string;
  currency: string;
  demo: boolean;
  discount_pct: number;
  terms_note: string;
}
interface SubRow {
  product: Product;
  plan_id: string | null;
  status: Subscription["status"];
  trial_ends: string | null;
  anchor: string | null;
  buildings_extra: number;
  buildings_override: number | null;
}

export type CatalogueData = Awaited<ReturnType<typeof loadCatalogue>>;

export interface EntitlementContext {
  catalogue: CatalogueData;
  org: OrgRecord;
  product: Product;
  /** The record for this product, as the rules see it. */
  view: OrgView;
  ent: Entitlement;
  /** Every product the organisation subscribes to, first product first. */
  products: Product[];
}

async function subscriptionRecord(db: Db, registry: ProductRegistry, o: OrgRow, s: SubRow): Promise<Subscription> {
  const where = [o.id, s.product];
  const addons = (
    await db.rows<{ module_key: string }>(
      "SELECT module_key FROM subscription_addons WHERE org_id = $1 AND product = $2 ORDER BY since, module_key",
      where,
    )
  ).map((r) => r.module_key);
  const disabled = (
    await db.rows<{ module_key: string }>(
      "SELECT module_key FROM subscription_disabled WHERE org_id = $1 AND product = $2",
      where,
    )
  ).map((r) => r.module_key);
  const pending = (
    await db.rows<{
      id: string;
      type: PendingChange["type"];
      module_key: string | null;
      plan_id: string | null;
      effective: string;
      reason: string | null;
    }>("SELECT * FROM subscription_pending WHERE org_id = $1 AND product = $2 ORDER BY created_at, id", where)
  ).map(
    (p) =>
      ({
        id: p.id,
        type: p.type,
        key: p.module_key,
        plan: p.plan_id,
        effective: p.effective,
        reason: p.reason,
      }) as PendingChange,
  );
  return {
    plan: s.plan_id ?? "CORE",
    status: s.status,
    trialEnds: s.trial_ends,
    anchor: s.anchor,
    addons,
    disabled,
    pending,
    buildings: { extra: s.buildings_extra, override: s.buildings_override },
    terms: { discountPct: Number(o.discount_pct), note: o.terms_note },
    usage: { buildings: await registry.usage(s.product, db, o.id) },
  };
}

/** The organisation with all its product subscriptions (first product in `ent`, the others in `subs`). */
export async function loadOrgRecord(db: Db, registry: ProductRegistry, orgId: string): Promise<OrgRecord | null> {
  const o = await db.row<OrgRow>(
    "SELECT id, name, currency, demo, discount_pct, terms_note FROM organisations WHERE id = $1",
    [orgId],
  );
  if (!o) return null;
  const subs = await db.rows<SubRow>("SELECT * FROM subscriptions WHERE org_id = $1 ORDER BY created_at, product", [
    orgId,
  ]);
  const [first, ...others] = subs;
  if (!first) return null;
  const record: OrgRecord = {
    id: o.id,
    name: o.name,
    type: first.product,
    currency: o.currency,
    demo: o.demo,
    ent: await subscriptionRecord(db, registry, o, first),
    subs: {},
  };
  for (const s of others)
    (record.subs as Record<string, Subscription>)[s.product] = await subscriptionRecord(db, registry, o, s);
  return record;
}

/** What one product subscription may use today. Product omitted = the organisation's first product. */
export async function resolveEntitlement(
  db: Db,
  registry: ProductRegistry,
  today: string,
  orgId: string,
  product?: Product,
): Promise<EntitlementContext | null> {
  const org = await loadOrgRecord(db, registry, orgId);
  if (!org) return null;
  const catalogue = await loadCatalogue(db);
  const p = (product ?? org.type) as Product;
  const view = entitlements.viewOf(catalogue, org, p, today);
  if (!view) return null;
  const ent = entitlements.resolve(catalogue, view, today) as Entitlement;
  return { catalogue, org, product: p, view, ent, products: entitlements.productsOf(org) as Product[] };
}
