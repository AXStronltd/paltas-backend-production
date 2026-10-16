/*
 * Organisations (PALTAS customers) and their members. Roles are per organisation; nobody becomes PALTAS staff here,
 * and PALTAS staff accounts can never join a customer organisation.
 */
import {
  rolesForProducts,
  ROLE_DEFINITIONS,
  type Member,
  type Organisation,
  type Product,
  type Role,
} from "@paltas/contracts";
import type { AppContext } from "../../context.js";
import type { Db } from "../../db/database.js";
import { fail } from "../../http/errors.js";
import type { OrgScope } from "../access/org-access.js";
import { recordAudit } from "../audit/audit.service.js";
import { createUser } from "../identity/identity.service.js";

interface MemberRow {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "suspended" | "invited";
  created_at: string;
}

const toMember = (r: MemberRow): Member => ({
  userId: r.user_id,
  email: r.email,
  // an invited person's own account details stay private until they accept
  name: r.status === "invited" ? r.email : r.name,
  role: r.role,
  status: r.status,
  since: r.created_at,
});

const MEMBER_SQL = `SELECT m.user_id, u.email, u.name, m.role, m.status, m.created_at
  FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1`;

export async function loadOrganisation(db: Db, orgId: string): Promise<Organisation | null> {
  const o = await db.row<{
    id: string;
    name: string;
    legal_name: string;
    registration_profile: Organisation["registrationProfile"];
    country: string;
    currency: string;
    timezone: string;
    demo: boolean;
    products: Product[];
  }>(
    `SELECT o.*, COALESCE(array_agg(s.product ORDER BY s.created_at, s.product) FILTER (WHERE s.product IS NOT NULL), '{}') AS products
     FROM organisations o LEFT JOIN subscriptions s ON s.org_id = o.id WHERE o.id = $1 GROUP BY o.id`,
    [orgId],
  );
  return o
    ? {
        id: o.id,
        name: o.name,
        legalName: o.legal_name,
        registrationProfile: o.registration_profile ?? null,
        country: o.country,
        currency: o.currency,
        timezone: o.timezone,
        demo: o.demo,
        products: o.products,
      }
    : null;
}

/** An organisation's members, by name (every status: active, suspended, invited). */
export async function loadMembers(db: Db, orgId: string): Promise<Member[]> {
  return (await db.rows<MemberRow>(MEMBER_SQL + " ORDER BY u.name", [orgId])).map(toMember);
}

export function organisationsService(ctx: AppContext) {
  const { db } = ctx;

  async function activeAdmins(t: Db, orgId: string): Promise<number> {
    return (
      (
        await t.row<{ n: number }>(
          "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'org_admin' AND status = 'active'",
          [orgId],
        )
      )?.n ?? 0
    );
  }

  return {
    async get(orgId: string) {
      const o = await loadOrganisation(db, orgId);
      if (!o) throw fail.notFound("Organisation not found");
      return o;
    },

    async listMembers(orgId: string) {
      return { members: await loadMembers(db, orgId) };
    },

    async addMember(s: OrgScope, input: { email: string; name?: string | undefined; role: Role }) {
      const allowed = rolesForProducts(s.entitlement.products);
      if (!allowed.includes(input.role)) {
        throw fail.invalid(
          `Role must be one of: ${allowed.map((r) => `${r} (${ROLE_DEFINITIONS[r].label})`).join(", ")}`,
        );
      }
      return db.tx(async (t) => {
        let u = await t.row<{ id: string; staff_role: string | null }>(
          "SELECT id, staff_role FROM users WHERE lower(email) = lower($1)",
          [input.email],
        );
        if (u?.staff_role) throw fail.invalid("PALTAS staff accounts cannot join a client organisation");
        let temporaryPassword: string | null = null;
        // a new account is created by this organisation and is active at once; an existing PALTAS account
        // belongs to its owner, so it is only invited and has no access here until that person accepts
        let status: "active" | "invited" = "invited";
        if (!u) {
          const created = await createUser(t, { email: input.email, name: input.name ?? input.email });
          u = { id: created.id, staff_role: null };
          temporaryPassword = created.temporaryPassword;
          status = "active";
        }
        if (await t.row("SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2", [s.orgId, u.id]))
          throw fail.conflict("Already a member or already invited");
        await t.run("INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, $3, $4)", [
          s.orgId,
          u.id,
          input.role,
          status,
        ]);
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: status === "invited" ? "Member invited" : "Member added",
          target: input.email,
          detail: input.role,
        });
        const row = await t.row<MemberRow>(MEMBER_SQL + " AND m.user_id = $2", [s.orgId, u.id]);
        return { member: toMember(row as MemberRow), temporaryPassword };
      });
    },

    async updateMember(
      s: OrgScope,
      userId: string,
      input: { role?: Role | undefined; status?: "active" | "suspended" | undefined },
    ) {
      if (userId === s.userId) throw fail.forbidden("You cannot change your own access — ask another administrator");
      return db.tx(async (t) => {
        // one access change per organisation at a time, so two administrators cannot remove each other at once
        await t.run("SELECT 1 FROM organisations WHERE id = $1 FOR UPDATE", [s.orgId]);
        const before = await t.row<MemberRow>(MEMBER_SQL + " AND m.user_id = $2", [s.orgId, userId]);
        if (!before) throw fail.notFound("Member not found");
        if (before.status === "invited" && input.status)
          throw fail.conflict("This person has not accepted the invitation yet");
        if (input.role && !rolesForProducts(s.entitlement.products).includes(input.role))
          throw fail.invalid("That role is not available for your products");
        await t.run(
          "UPDATE memberships SET role = COALESCE($3, role), status = COALESCE($4, status) WHERE org_id = $1 AND user_id = $2",
          [s.orgId, userId, input.role ?? null, input.status ?? null],
        );
        if ((await activeAdmins(t, s.orgId)) === 0)
          throw fail.conflict("The organisation must keep at least one active administrator");
        // a suspended member is signed out everywhere
        if (input.status === "suspended") {
          await t.run(
            `DELETE FROM sessions WHERE user_id = $1 AND NOT EXISTS (
               SELECT 1 FROM memberships WHERE user_id = $1 AND status = 'active' AND org_id <> $2)`,
            [userId, s.orgId],
          );
        }
        const after = (await t.row<MemberRow>(MEMBER_SQL + " AND m.user_id = $2", [s.orgId, userId])) as MemberRow;
        await recordAudit(t, {
          actor: s.actor,
          orgId: s.orgId,
          action: "Member access changed",
          target: after.email,
          before: { role: before.role, status: before.status },
          after: { role: after.role, status: after.status },
        });
        return toMember(after);
      });
    },
  };
}

export type OrganisationsService = ReturnType<typeof organisationsService>;
