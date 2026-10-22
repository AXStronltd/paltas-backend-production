/** Owner-controlled delegation. Decisions are read from PostgreSQL on every request; no token/cache grants. */
import {
  CAPABILITIES,
  delegatedCapabilityCan,
  roleCan,
  type Capability,
  type ManagerGrant,
  type Product,
  type ProductRoles,
  type Role,
} from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import { recordAudit } from "../audit/audit.service.js";
import type { OrgScope } from "./org-access.js";

export async function managerGrant(
  db: Db,
  orgId: string,
  userId: string,
  product: Product,
): Promise<ManagerGrant | null> {
  const r = await db.row<{
    product: Product;
    capabilities: Capability[];
    property_ids: string[] | null;
    enabled: boolean;
  }>(
    "SELECT product,capabilities,property_ids,enabled FROM main_manager_grants WHERE org_id=$1 AND user_id=$2 AND product=$3",
    [orgId, userId, product],
  );
  return r
    ? { product: r.product, capabilities: r.capabilities, propertyIds: r.property_ids, enabled: r.enabled }
    : null;
}
export const delegatedCan = delegatedCapabilityCan;
export async function memberCan(db: Db, orgId: string, userId: string, role: Role, product: Product, cap: Capability) {
  return role === "main_manager"
    ? delegatedCan(await managerGrant(db, orgId, userId, product), cap)
    : roleCan(role, cap);
}
const forbidden = (c: Capability) =>
  (c.startsWith("subscription.") && c !== "subscription.read") || c.startsWith("migration.");
export function managerDelegation(ctx: Pick<AppContext, "db">) {
  const db = ctx.db;
  async function owner(s: OrgScope) {
    const r = await db.row<{ role: string }>(
      "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 AND status='active'",
      [s.orgId, s.userId],
    );
    if (r?.role !== "org_admin")
      throw fail.forbidden("Only the company administrator can appoint or change Main Managers");
  }
  async function list(s: OrgScope, userId: string) {
    await owner(s);
    const rows = await db.rows<{ product: Product }>(
      "SELECT product FROM main_manager_grants WHERE org_id=$1 AND user_id=$2 ORDER BY product",
      [s.orgId, userId],
    );
    return {
      grants: (await Promise.all(rows.map((r) => managerGrant(db, s.orgId, userId, r.product)))).filter(
        (x): x is ManagerGrant => !!x,
      ),
    };
  }
  return {
    list,
    async save(s: OrgScope, userId: string, b: { grants: ManagerGrant[]; reason: string }) {
      await owner(s);
      if (userId === s.userId) throw fail.forbidden("You cannot delegate to yourself");
      const member = await db.row<{ role: Role; product_roles: ProductRoles | null }>(
        "SELECT role,product_roles FROM memberships WHERE org_id=$1 AND user_id=$2",
        [s.orgId, userId],
      );
      if (!member) throw fail.notFound("Team member not found");
      if (member.role === "org_admin")
        throw fail.forbidden("An organisation administrator must first be changed to an operational role");
      if (new Set(b.grants.map((g) => g.product)).size !== b.grants.length)
        throw fail.invalid("Choose each product once");
      for (const g of b.grants) {
        if (!s.entitlement.products.includes(g.product))
          throw fail.invalid("The organisation does not hold that product");
        if (
          g.capabilities.some(
            (c) =>
              forbidden(c) ||
              (!c.startsWith(g.product + ".") &&
                !c.startsWith("contacts.") &&
                !c.startsWith("ledger.") &&
                !["org.read", "members.read", "members.manage", "audit.read", "subscription.read"].includes(c)),
          )
        )
          throw fail.invalid("A permission does not belong to this operational product");
        if (g.capabilities.includes("members.manage") && g.propertyIds !== null)
          throw fail.invalid(
            "Staff access changes require organisation-wide delegation; a scoped manager cannot grant unscoped staff roles",
          );
        if (g.propertyIds !== null) {
          if (g.product !== "property")
            throw fail.invalid(
              "Use the existing product's site/property assignment workflow for non-Property products",
            );
          const rows = await db.rows<{ id: string }>("SELECT id FROM pm_properties WHERE org_id=$1 AND id=ANY($2)", [
            s.orgId,
            g.propertyIds,
          ]);
          if (rows.length !== new Set(g.propertyIds).size)
            throw fail.invalid("A selected property does not belong to this organisation");
        }
      }
      await db.tx(async (t) => {
        await t.run("SELECT 1 FROM organisations WHERE id=$1 FOR UPDATE", [s.orgId]);
        const caller = await t.row<{ role: string }>(
          "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 AND status='active'",
          [s.orgId, s.userId],
        );
        const target = await t.row<{ role: string }>(
          "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE",
          [s.orgId, userId],
        );
        if (caller?.role !== "org_admin" || target?.role === "org_admin")
          throw fail.forbidden("Only the current company administrator may delegate operational access");
        const before = await t.rows("SELECT * FROM main_manager_grants WHERE org_id=$1 AND user_id=$2", [
          s.orgId,
          userId,
        ]);
        await t.run("DELETE FROM main_manager_grants WHERE org_id=$1 AND user_id=$2", [s.orgId, userId]);
        for (const g of b.grants)
          await t.run(
            "INSERT INTO main_manager_grants(org_id,user_id,product,capabilities,property_ids,enabled,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [s.orgId, userId, g.product, [...new Set(g.capabilities)], g.propertyIds, g.enabled, s.userId],
          );
        // The explicit allowlist prevents a legacy role from granting another product accidentally.
        const roles = Object.fromEntries(b.grants.map((g) => [g.product, "main_manager"]));
        await t.run("UPDATE memberships SET role='main_manager',product_roles=$3 WHERE org_id=$1 AND user_id=$2", [
          s.orgId,
          userId,
          JSON.stringify(roles),
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Main Manager permissions changed",
          target: userId,
          detail: b.reason,
          before,
          after: b.grants,
        });
      });
      return list(s, userId);
    },
  };
}
export const MANAGER_CAPABILITIES = CAPABILITIES.filter((c) => !forbidden(c));
