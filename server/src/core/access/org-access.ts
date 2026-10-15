/*
 * The one gate for every request about an organisation's data. A handler states what it needs:
 *
 *   const s = await core.access.scope(req.user, req.params.orgId, { capability: "ledger.prepare", write: true, module: "finance" });
 *
 * and gets back who is acting, in which role, for which product subscription — or a clear refusal:
 *   - not a member (or suspended)           → 404 (someone else's organisation looks like one that does not exist)
 *   - the role lacks the capability          → 403 ROLE_NOT_ALLOWED
 *   - no subscription for that product       → 404
 *   - a change while the subscription is not active → 402 SUBSCRIPTION_INACTIVE (records stay readable)
 *   - a module outside the plan               → 403 MODULE_NOT_ENTITLED (with what it would cost)
 */
import { entitlements, ROLE_DEFINITIONS, roleCan, type Capability, type Product, type Role } from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import { fail } from "../../http/errors.js";
import type { Actor } from "../audit/audit.service.js";
import type { SessionUser } from "../identity/identity.service.js";
import { resolveEntitlement, type EntitlementContext } from "../subscriptions/entitlement.service.js";

export interface ScopeOptions {
  capability: Capability;
  /** The product subscription asked for (?product= or body.product). Default: the organisation's first product. */
  product?: Product | undefined;
  /** For product workspaces: the first of these products the organisation holds is used; none → 404. */
  products?: readonly Product[];
  /** The request changes data: the subscription must be active (or in trial). */
  write?: boolean;
  /** The module this action needs. Checked on writes (and on reads when moduleOnRead is set). */
  module?: string;
  moduleOnRead?: boolean;
  /**
   * For organisation-wide records (the ledger, members): use whichever of the organisation's product subscriptions
   * is usable and includes the module, instead of only the first product.
   */
  anyProduct?: boolean;
}

export interface OrgScope {
  orgId: string;
  userId: string;
  role: Role;
  product: Product;
  entitlement: EntitlementContext;
  /** For the audit log. */
  actor: Actor;
  /** Business date the decision was made on. */
  today: string;
}

export function orgAccess(ctx: AppContext) {
  const { db, clock, products: registry } = ctx;

  async function scope(user: SessionUser, orgId: string, o: ScopeOptions): Promise<OrgScope> {
    const m = await db.row<{ role: Role; status: string }>(
      "SELECT role, status FROM memberships WHERE org_id = $1 AND user_id = $2",
      [orgId, user.id],
    );
    if (!m || m.status !== "active") throw fail.notFound("Organisation not found");
    if (!roleCan(m.role, o.capability)) {
      throw fail.roleNotAllowed(`Your role (${ROLE_DEFINITIONS[m.role].label}) cannot do this`);
    }
    const first = await resolveEntitlement(db, registry, clock.today(), orgId);
    if (!first) throw fail.notFound("Organisation not found");
    let product: Product | undefined = o.product;
    if (o.products) {
      product = o.products.find((p) => first.products.includes(p));
      if (!product) throw fail.notFound("This workspace is not part of your organisation's subscriptions");
    }
    if (product && !first.products.includes(product)) {
      throw fail.notFound(`Your organisation has no ${entitlements.PRODUCT_NAME[product] ?? product} subscription`);
    }
    let en =
      product && product !== first.product
        ? await resolveEntitlement(db, registry, clock.today(), orgId, product)
        : first;
    if (o.anyProduct && !product && en && !(en.ent.usable && (!o.module || en.ent.modules[o.module]))) {
      for (const p of first.products.slice(1)) {
        const other = await resolveEntitlement(db, registry, clock.today(), orgId, p);
        if (other && other.ent.usable && (!o.module || other.ent.modules[o.module])) {
          en = other;
          break;
        }
      }
    }
    if (!en) throw fail.notFound("Organisation not found");
    const s: OrgScope = {
      orgId,
      userId: user.id,
      role: m.role,
      product: en.product,
      entitlement: en,
      actor: { userId: user.id, role: m.role },
      today: clock.today(),
    };
    if (o.write) requireActive(s);
    if (o.module && (o.write || o.moduleOnRead)) requireModule(s, o.module);
    return s;
  }

  return { scope };
}

export type OrgAccess = ReturnType<typeof orgAccess>;

/** Changes need an active (or trial) subscription. Records stay readable. */
export function requireActive(s: OrgScope): void {
  const e = s.entitlement.ent;
  if (!e.usable) {
    throw fail.subscriptionInactive(
      `Your subscription is ${e.status}. Records are kept and readable; choose a plan to make changes again.`,
      { status: e.status },
    );
  }
}

export function requireModule(s: OrgScope, key: string): void {
  const { ent, catalogue, view } = s.entitlement;
  if (ent.modules[key]) return;
  const st = ent.moduleState[key];
  const q = entitlements.canBuy(catalogue, view, key, s.today);
  const name = catalogue.modules.find((m) => m.key === key)?.name ?? key;
  throw fail.moduleNotEntitled(`${name} is not in your plan. Existing records stay readable.`, {
    module: key,
    reason: st?.why || "Not in your plan",
    canBuy: q.ok,
    price: q.ok ? q.price : null,
    contactSales: !q.ok && !!q.contactSales,
  });
}

/** Creating another building or project needs a free allowance. */
export function requireAllowance(s: OrgScope): void {
  const b = s.entitlement.ent.buildings;
  if (b.used < b.allowed) return;
  throw fail.allowanceExceeded(
    `All ${b.allowed} ${s.product === "developer" ? "project" : "building"} allowance(s) in your plan are in use`,
    {
      used: b.used,
      allowed: b.allowed,
      extraPrice: s.entitlement.ent.extraBuilding ?? null,
      upgrades: s.entitlement.ent.upgrades,
    },
  );
}
